"use client";

import { useMemo } from "react";

import { Room } from "@/components/room";
import { e2eTokenFetcher } from "@/lib/sync/auth";
import { Canvas } from "@/app/board/[boardId]/_components/canvas";
import { Loading } from "@/app/board/[boardId]/_components/loading";
import { E2eProbe } from "./e2e-probe";

interface E2eBoardProps {
    boardId: string;
    user: string;
}

export const E2eBoard = ({ boardId, user }: E2eBoardProps) => {
    // Stable per user, so the room doesn't reconnect on every render.
    const authenticate = useMemo(() => e2eTokenFetcher(user), [user]);

    return (
        <Room roomId={boardId} fallback={<Loading />} backend="buddysync" authenticate={authenticate}>
            <E2eProbe />
            <Canvas
                boardId={boardId}
                header={
                    <div
                        data-testid="e2e-header"
                        className="absolute top-2 left-2 bg-white rounded-md px-3 h-12 flex items-center shadow-md text-sm"
                    >
                        Test board {boardId} · {user}
                    </div>
                }
            />
        </Room>
    );
};
