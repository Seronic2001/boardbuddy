import { notFound } from "next/navigation";

import { isE2eBoardId, isE2eEnabled } from "@/lib/e2e";
import { E2eBoard } from "./e2e-board";

// Test-only: the real canvas on BuddySync, signed in as a made-up user, no Clerk or Convex.
//   /e2e/board/e2e-<anything>?user=alice
// 404 unless E2E_TEST_AUTH=1 outside production; see lib/e2e.ts.

interface E2eBoardPageProps {
    params: Promise<{ boardId: string }>;
    searchParams: Promise<{ user?: string | string[] }>;
}

const USER = /^[A-Za-z0-9_-]{1,32}$/;

const E2eBoardPage = async ({ params, searchParams }: E2eBoardPageProps) => {
    const { boardId } = await params;
    const { user } = await searchParams;

    const buddySyncConfigured = Boolean(process.env.NEXT_PUBLIC_SYNC_URL && process.env.SYNC_PRIVATE_KEY);
    if (!isE2eEnabled() || !buddySyncConfigured || !isE2eBoardId(boardId)) notFound();

    const name = typeof user === "string" && USER.test(user) ? user : "tester";
    return <E2eBoard boardId={boardId} user={name} />;
};

export default E2eBoardPage;
