"use client";

import { useEffect } from "react";

import { useSyncBackend } from "@/lib/sync";
import type { Layer } from "@/types/canvas";

/**
 * Read-only window hook so Playwright can compare whole documents across browsers.
 * Edits still go through the real UI; this only reads.
 */
export type E2eSnapshot = {
    layerIds: string[];
    layers: Record<string, Layer>;
};

declare global {
    interface Window {
        __e2e?: {
            snapshot(): E2eSnapshot;
            status(): string;
        };
    }
}

export const E2eProbe = () => {
    const backend = useSyncBackend();

    useEffect(() => {
        window.__e2e = {
            snapshot: () => {
                const storage = backend.getStorage();
                return {
                    layerIds: [...storage.layerIds],
                    layers: Object.fromEntries(storage.layers),
                };
            },
            status: () => backend.getStatus(),
        };
        return () => {
            delete window.__e2e;
        };
    }, [backend]);

    return null;
};
