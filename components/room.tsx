"use client";

import { LiveList, LiveMap, LiveObject } from "@liveblocks/client";
import { ClientSideSuspense } from "@liveblocks/react";
import { ReactNode, useEffect, useMemo, useState } from "react";

import { BuddySyncConnection } from "@boardbuddy/sync-client";
import { RoomProvider, useRoom, useSelf, useStorage } from "@/liveblocks.config";
import { fetchSyncToken } from "@/lib/sync/auth";
import { BuddySyncBackend } from "@/lib/sync/buddysync-backend";
import { LiveblocksBackend } from "@/lib/sync/liveblocks-backend";
import { SyncBackendProvider } from "@/lib/sync";
import { INITIAL_PRESENCE } from "@/lib/sync/types";
import type { SyncBackendKind } from "@/lib/sync/flag";
import { Layer } from "@/types/canvas";

interface RoomProps {
    children: ReactNode;
    roomId: string;
    fallback: NonNullable<ReactNode> | null;
    backend: SyncBackendKind;
}

export const Room = ({ children, roomId, fallback, backend }: RoomProps) =>
    backend === "buddysync" ? (
        <BuddySyncRoom roomId={roomId} fallback={fallback}>{children}</BuddySyncRoom>
    ) : (
        <LiveblocksRoom roomId={roomId} fallback={fallback}>{children}</LiveblocksRoom>
    );

// ---- Liveblocks (rollback path) --------------------------------------------------------

const LiveblocksRoom = ({ children, roomId, fallback }: Omit<RoomProps, "backend">) => (
    <RoomProvider
        id={roomId}
        initialPresence={INITIAL_PRESENCE}
        initialStorage={{
            layers: new LiveMap<string, LiveObject<Layer>>(),
            layerIds: new LiveList(),
        }}
    >
        <ClientSideSuspense fallback={fallback}>
            {() => <LiveblocksBridge>{children}</LiveblocksBridge>}
        </ClientSideSuspense>
    </RoomProvider>
);

const LiveblocksBridge = ({ children }: { children: ReactNode }) => {
    // These suspend until storage and self are loaded, so the backend's getters are safe.
    useStorage(() => null);
    useSelf(() => null);
    const room = useRoom();
    const backend = useMemo(() => new LiveblocksBackend(room), [room]);
    return <SyncBackendProvider backend={backend}>{children}</SyncBackendProvider>;
};

// ---- BuddySync -------------------------------------------------------------------------

// One id per page load. Not sessionStorage: duplicating a tab copies sessionStorage, and two
// tabs with one id would keep replacing each other's connection.
const TAB_ID = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");

const BuddySyncRoom = ({ children, roomId, fallback }: Omit<RoomProps, "backend">) => {
    const [backend, setBackend] = useState<BuddySyncBackend | null>(null);
    const [denied, setDenied] = useState(false);

    useEffect(() => {
        const connection = new BuddySyncConnection({
            boardId: roomId,
            authenticate: fetchSyncToken,
            tabId: TAB_ID,
        });
        const offLoaded = connection.on("loaded", () => setBackend(new BuddySyncBackend(connection)));
        const offStatus = connection.on("status", () => {
            if (connection.status === "disconnected" && !connection.isLoaded) setDenied(true);
        });
        const onOnline = () => connection.reconnectNow();
        window.addEventListener("online", onOnline);
        connection.start();
        return () => {
            offLoaded();
            offStatus();
            window.removeEventListener("online", onOnline);
            connection.stop();
            setBackend(null);
            setDenied(false);
        };
    }, [roomId]);

    if (denied) {
        return (
            <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
                You don&apos;t have access to this board.
            </div>
        );
    }
    if (!backend) return fallback;
    return <SyncBackendProvider backend={backend}>{children}</SyncBackendProvider>;
};
