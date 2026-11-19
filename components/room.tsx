"use client";

import { ReactNode, useEffect, useState } from "react";

import { BuddySyncConnection } from "@boardbuddy/sync-client";
import { fetchSyncToken, type Authenticate } from "@/lib/sync/auth";
import { BuddySyncBackend } from "@/lib/sync/buddysync-backend";
import { SyncBackendProvider } from "@/lib/sync";

interface RoomProps {
    children: ReactNode;
    roomId: string;
    fallback: NonNullable<ReactNode> | null;
    /** Where room tokens come from. Defaults to /api/sync-auth (Clerk). */
    authenticate?: Authenticate;
}

export const Room = ({
    children,
    roomId,
    fallback,
    authenticate = fetchSyncToken,
}: RoomProps) => {
    const [backend, setBackend] = useState<BuddySyncBackend | null>(null);
    const [denied, setDenied] = useState(false);

    useEffect(() => {
        // Tab identity and unsent edits are kept in IndexedDB; a reload adopts its saved
        // identity (guarded by a Web Lock), so offline edits survive closing the tab.
        const connection = new BuddySyncConnection({
            boardId: roomId,
            authenticate,
        });
        const offLoaded = connection.on("loaded", () => setBackend(new BuddySyncBackend(connection)));
        const offStatus = connection.on("status", () => {
            if (connection.status === "disconnected" && !connection.isLoaded) setDenied(true);
        });
        const onOnline = () => connection.reconnectNow();
        const onPageHide = () => void connection.persistNow();
        window.addEventListener("online", onOnline);
        window.addEventListener("pagehide", onPageHide);
        connection.start();
        return () => {
            offLoaded();
            offStatus();
            window.removeEventListener("online", onOnline);
            window.removeEventListener("pagehide", onPageHide);
            connection.stop();
            setBackend(null);
            setDenied(false);
        };
    }, [roomId, authenticate]);

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
