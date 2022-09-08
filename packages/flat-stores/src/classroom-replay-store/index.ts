import videojs from "video.js";

import { FastboardPlayer, replayFastboard, Storage } from "@netless/fastboard";
import { SyncPlayer, VideoPlayer, WhiteboardPlayer } from "@netless/sync-player";
import { addYears } from "date-fns";
import { ChatMsg } from "flat-components";
import { makeAutoObservable, observable, runInAction } from "mobx";
import { SideEffectManager } from "side-effect-manager";

import { OnStageUsersStorageState } from "../classroom-store";
import { ClassroomReplayEventData } from "../classroom-store/event";
import { globalStore } from "../global-store";
import { RoomItem, RoomRecording, roomStore } from "../room-store";
import { UserStore } from "../user-store";
import { TextChatHistory } from "./history";
import { AtomPlayer, getRecordings, makeVideoPlayer, Recording } from "./utils";

export interface ClassroomReplayStoreConfig {
    roomUUID: string;
    ownerUUID: string;
}

export class ClassroomReplayStore {
    public readonly sideEffect = new SideEffectManager();

    public readonly roomUUID: string;
    public readonly ownerUUID: string;
    public readonly userUUID: string;

    public readonly history: TextChatHistory;

    public readonly users: UserStore;
    public readonly onStageUserUUIDs = observable.array<string>();
    public readonly recordings = observable.array<Recording>();
    public readonly userVideos = observable.map<string, videojs.Player>();

    public syncPlayer: AtomPlayer | null = null;

    /** RTM messages */
    public messages = observable.array<ChatMsg>();

    public fastboard: FastboardPlayer<ClassroomReplayEventData> | null = null;

    public onStageUsersStorage: Storage<OnStageUsersStorageState> | null = null;

    public currentRecording: RoomRecording | null = null;

    public isPlaying = false;
    public isBuffering = false;
    public tempTimestamp = 0;
    public realTimestamp = 0;

    public get currentTimestamp(): number {
        return this.tempTimestamp || this.realTimestamp;
    }

    private cachedMessages = observable.array<ChatMsg>();
    private _oldestSeekTime = -1;
    private _isLoadingHistory = false;
    private _remoteNewestTimestamp = Infinity;

    public constructor(config: ClassroomReplayStoreConfig) {
        if (!globalStore.userUUID) {
            throw new Error("Missing userUUID");
        }

        (window as any).classroomReplayStore = this;

        this.roomUUID = config.roomUUID;
        this.ownerUUID = config.ownerUUID;
        this.userUUID = globalStore.userUUID;
        this.history = new TextChatHistory(this);

        this.users = new UserStore({
            roomUUID: config.roomUUID,
            ownerUUID: config.ownerUUID,
            userUUID: this.userUUID,
            isInRoom: () => false,
        });

        makeAutoObservable<
            this,
            "_isLoadingHistory" | "_oldestSeekTime" | "_remoteNewestTimestamp"
        >(this, {
            sideEffect: false,
            history: false,
            fastboard: observable.ref,
            syncPlayer: observable.ref,
            currentRecording: observable.ref,
            onStageUsersStorage: false,
            _isLoadingHistory: false,
            _oldestSeekTime: false,
            _remoteNewestTimestamp: false,
        });
    }

    public get roomInfo(): RoomItem | undefined {
        return roomStore.rooms.get(this.roomUUID);
    }

    public get isCreator(): boolean {
        return this.ownerUUID === this.userUUID;
    }

    public async init(): Promise<void> {
        this.updateRecordings(await getRecordings(this.roomUUID));
    }

    public async destroy(): Promise<void> {
        this.sideEffect.flushAll();
        this.fastboard?.destroy();
    }

    public updateRecordings(recordings: Recording[]): void {
        this.recordings.replace(recordings);
    }

    public async loadRecording(recording: Recording): Promise<void> {
        if (!process.env.NETLESS_APP_IDENTIFIER) {
            throw new Error("Missing NETLESS_APP_IDENTIFIER");
        }

        if (!globalStore.whiteboardRoomUUID || !globalStore.whiteboardRoomToken) {
            throw new Error("Missing whiteboard UUID and Token");
        }

        if (recording === this.currentRecording) {
            return;
        }

        this.currentRecording = recording;
        this.isPlaying = false;

        const fastboard = await replayFastboard<ClassroomReplayEventData>({
            sdkConfig: {
                appIdentifier: process.env.NETLESS_APP_IDENTIFIER,
                region: globalStore.region ?? "cn-hz",
                pptParams: {
                    useServerWrap: true,
                },
            },
            replayRoom: {
                room: globalStore.whiteboardRoomUUID,
                roomToken: globalStore.whiteboardRoomToken,
                beginTimestamp: recording.beginTime,
                duration: recording.endTime - recording.beginTime,
            },
            managerConfig: {
                cursor: true,
            },
        });
        this.sideEffect.push(
            fastboard.phase.subscribe(phase => {
                runInAction(() => {
                    this.isBuffering = phase === "buffering";
                    if (phase === "ended") {
                        this.pause();
                    }
                });
            }),
            "isBuffering",
        );

        const onStageUsersStorage = fastboard.syncedStore.connectStorage<OnStageUsersStorageState>(
            "onStageUsers",
            {},
        );
        this.sideEffect.push(
            onStageUsersStorage.on("stateChanged", () => {
                const onStageUserUUIDs = [];
                for (const key in onStageUsersStorage.state) {
                    if (onStageUsersStorage.state[key]) {
                        onStageUserUUIDs.push(key);
                    }
                }
                this.onStageUserUUIDs.replace(onStageUserUUIDs);
            }),
            "onStageUsers",
        );

        this.users.initUsers([this.ownerUUID]);
        this.updateFastboard(fastboard, onStageUsersStorage);

        const players: AtomPlayer[] = [];
        players.push(new WhiteboardPlayer({ name: "whiteboard", player: fastboard.player }));
        const userVideos = new Map<string, videojs.Player>();
        if (recording.videoURL) {
            const mainVideo = makeVideoPlayer(recording.videoURL);
            userVideos.set(this.userUUID, mainVideo);
            players.push(new VideoPlayer({ name: "main", video: mainVideo }));
        }
        if (recording.users) {
            for (const userUUID in recording.users) {
                const { videoURL } = recording.users[userUUID];
                const userVideo = makeVideoPlayer(videoURL);
                userVideos.set(userUUID, userVideo);
                players.push(new VideoPlayer({ name: userUUID, video: userVideo }));
            }
        }
        const syncPlayer = new SyncPlayer({ players });
        this.sideEffect.add(() => {
            syncPlayer.on("timeupdate", this.syncMessages);
            return () => {
                syncPlayer.off("timeupdate", this.syncMessages);
            };
        }, "syncMessages");
        this.updateUserVideos(userVideos, syncPlayer);
    }

    public updateUserVideos(userVideos: Map<string, videojs.Player>, player: AtomPlayer): void {
        this.userVideos.replace(userVideos);
        this.syncPlayer = player;
    }

    public updateFastboard(
        fastboard: FastboardPlayer,
        onStageUsersStorage: Storage<OnStageUsersStorageState>,
    ): void {
        if (this.fastboard) {
            this.fastboard.destroy();
        }
        this.fastboard = fastboard;
        this.onStageUsersStorage = onStageUsersStorage;
    }

    public onNewMessage(msg: ChatMsg): void {
        this.messages.push(msg);
    }

    public play(): void {
        this.syncPlayer?.play();
        this.isPlaying = true;
    }

    public pause(): void {
        this.isPlaying = false;
        this.syncPlayer?.pause();
    }

    public seek = (timestamp: number): void => {
        this.tempTimestamp = timestamp;
        this.sideEffect.setTimeout(this.seekNow, 100, "seek");
    };

    private seekNow = (): void => {
        if (this.currentRecording && this.syncPlayer) {
            this.syncPlayer.seek(this.tempTimestamp - this.currentRecording.beginTime);
        }
    };

    public togglePlayPause = (): void => {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    };

    private syncMessages = async (): Promise<void> => {
        if (!this.syncPlayer || !this.currentRecording) {
            return;
        }

        if (this._isLoadingHistory) {
            return;
        }

        const currentTimestamp = this.currentRecording.beginTime + this.syncPlayer.currentTime;
        this.realTimestamp = currentTimestamp;
        if (this.tempTimestamp === this.realTimestamp) {
            this.tempTimestamp = 0;
        }
        if (this.cachedMessages.length === 0) {
            const newMessages = await this.getHistory(currentTimestamp - 1);
            if (newMessages.length === 0) {
                return;
            }
            this._oldestSeekTime = currentTimestamp;
            runInAction(() => {
                this.cachedMessages.replace(newMessages);
            });
            return this.syncMessages();
        }

        if (currentTimestamp < this._oldestSeekTime) {
            runInAction(() => {
                this.messages.clear();
                this.cachedMessages.clear();
            });
            return this.syncMessages();
        }

        if (
            this.messages.length > 0 &&
            currentTimestamp < this.messages[this.messages.length - 1].timestamp
        ) {
            runInAction(() => {
                this.messages.clear();
            });
            return this.syncMessages();
        }

        let start = this.messages.length;
        while (
            start < this.cachedMessages.length &&
            currentTimestamp >= this.cachedMessages[start].timestamp
        ) {
            start++;
        }

        if (start === this.messages.length) {
            // no new messages
            return;
        }

        if (start >= this.cachedMessages.length) {
            // more messages need to be loaded
            const newMessages = await this.getHistory(
                this.cachedMessages[this.cachedMessages.length - 1].timestamp,
            );
            if (newMessages.length > 0) {
                runInAction(() => {
                    this.cachedMessages.push(...newMessages);
                });
                return this.syncMessages();
            }
        }

        runInAction(() => {
            this.messages.push(...this.cachedMessages.slice(this.messages.length, start));
        });
    };

    private getHistory = async (newestTimestamp: number): Promise<ChatMsg[]> => {
        let history: ChatMsg[] = [];

        if (newestTimestamp >= this._remoteNewestTimestamp) {
            return history;
        }

        this._isLoadingHistory = true;

        try {
            const messages = await this.history.fetchTextHistory(
                newestTimestamp + 1,
                addYears(newestTimestamp, 1).valueOf(),
            );

            if (messages.length === 0) {
                this._remoteNewestTimestamp = newestTimestamp;
            }

            history = messages.map(msg => ({
                type: "room-message",
                ...msg,
            }));

            // fetch user name first to avoid flashing
            await this.users
                .syncExtraUsersInfo(history.map(msg => msg.senderID))
                .catch(console.warn); // swallow error
        } catch (error) {
            console.warn(error);
        }

        this._isLoadingHistory = false;

        return history;
    };
}