import { api } from '@/convex/_generated/api'
import { issueRoomToken } from '@/lib/sync/token'
import { auth, currentUser } from '@clerk/nextjs/server'
import { ConvexHttpClient } from 'convex/browser'

// Room tokens for the BuddySync server. Same authorization as /api/liveblocks-auth:
// signed-in Clerk user, active organization, and the board must belong to that organization
// (Convex is queried with the caller's own token). The sync server only verifies the
// signature with the public key.

export async function POST(request : Request) {
    const authorization = await auth();
    const user = await currentUser();

    if(!user || !authorization.orgId) {
        return new Response('Unauthorized', {status : 403})
    }

    const privateKey = process.env.SYNC_PRIVATE_KEY
    const syncUrl = process.env.NEXT_PUBLIC_SYNC_URL
    if (!process.env.NEXT_PUBLIC_CONVEX_URL || !privateKey || !syncUrl) {
        return new Response('Server misconfigured', {status : 500})
    }

    const { room } = await request.json().catch(() => ({}))
    const token = await authorization.getToken({ template : "convex" })

    if(typeof room !== "string" || !token) {
        return new Response('Unauthorized', {status : 403})
    }

    const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL)
    convex.setAuth(token)

    // Convex only returns the board to members of its organization.
    const board = await convex.query(api.board.get, { id : room });

    if(!board || board.orgId !== authorization.orgId) {
        return new Response('Unauthorized', {status : 403})
    }

    const body = await issueRoomToken(
        {
            userId : user.id,
            boardId : room,
            orgId : authorization.orgId,
            // Every org member can edit today; viewers are supported by the sync server.
            role : "editor",
            name : user.firstName || "Teammate",
            picture : user.imageUrl,
        },
        { privateKey, syncUrl },
    )

    return Response.json(body, { headers : { 'cache-control' : 'no-store' } })
}
