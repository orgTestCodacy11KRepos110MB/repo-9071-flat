import { useEffect, useRef, useState } from "react";
import { listen } from "@wopjs/dom";
import { noop } from "lodash-es";

export interface Draggable {
    readonly isDragging: boolean;
    readonly makeDraggable: (div: HTMLDivElement | null) => void;
}

export function useDraggable(): Draggable {
    const [div, makeDraggable] = useState<HTMLDivElement | null>(null);
    const start = useRef<[x: number, left: number] | undefined>();
    const [isDragging, setDragging] = useState(false);

    useEffect(() => {
        if (div) {
            let stopListenMove = noop;

            const stopListenDown = listen(div, "pointerdown", ev => {
                // is dragging avatar, not the buttons on it
                const isAvatar = (ev.target as HTMLElement).classList?.contains("video-avatar");
                if (isAvatar && ev.pointerType === "mouse" && ev.isPrimary && ev.button === 0) {
                    div.setPointerCapture(ev.pointerId);
                    start.current = [ev.clientX, div.scrollLeft];
                    setDragging(true);

                    stopListenMove = listen(div, "pointermove", ev => {
                        if (ev.isPrimary && start.current) {
                            const dx = ev.clientX - start.current[0];
                            div.scrollLeft = start.current[1] - dx;
                        }
                    });
                }
            });

            const onPointerUp = (ev: PointerEvent): void => {
                div.releasePointerCapture(ev.pointerId);
                start.current = undefined;
                setDragging(false);
                stopListenMove();
                stopListenMove = noop;
            };
            const stopListenUp = listen(div, "pointerup", onPointerUp);
            const stopListenCancel = listen(div, "pointercancel", onPointerUp);

            return () => {
                stopListenDown();
                stopListenMove();
                stopListenUp();
                stopListenCancel();
            };
        }
        return;
    }, [div]);

    return { isDragging, makeDraggable };
}
