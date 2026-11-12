import { E2E_ORG_ID, e2eUserId, isE2eEnabled, parseE2eTokenRequest } from '@/lib/e2e'
import { issueRoomToken } from '@/lib/sync/token'

// Test-only room tokens for made-up users, without Clerk or Convex. See lib/e2e.ts for
// when this is enabled; otherwise it answers 404 as if it didn't exist.

export async function POST(request : Request) {
    if (!isE2eEnabled()) {
        return new Response('Not found', {status : 404})
    }

    const privateKey = process.env.SYNC_PRIVATE_KEY
    const syncUrl = process.env.NEXT_PUBLIC_SYNC_URL
    if (!privateKey || !syncUrl) {
        return new Response('Server misconfigured', {status : 500})
    }

    const parsed = parseE2eTokenRequest(await request.json().catch(() => null))
    if (!parsed) {
        return new Response('Unauthorized', {status : 403})
    }

    const body = await issueRoomToken(
        {
            userId : e2eUserId(parsed.user),
            boardId : parsed.boardId,
            orgId : E2E_ORG_ID,
            role : parsed.role,
            name : parsed.user,
        },
        { privateKey, syncUrl },
    )

    return Response.json(body, { headers : { 'cache-control' : 'no-store' } })
}
