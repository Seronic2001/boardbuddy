"use client";

import { useStatus } from "@/lib/sync";

// Edits keep working while disconnected (they queue locally), so this only informs.
export const ConnectionStatus = () => {
  const status = useStatus();

  if (status !== "reconnecting" && status !== "disconnected") {
    return null;
  }

  return (
    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-white rounded-md px-3 py-1.5 shadow-md text-xs text-neutral-600">
      {status === "reconnecting"
        ? "Reconnecting… your changes will sync when you're back online"
        : "Disconnected. Refresh to rejoin the board."}
    </div>
  );
};
