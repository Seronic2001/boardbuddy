import { api } from '@/convex/_generated/api'
import { auth, currentUser } from '@clerk/nextjs/server'
import { Liveblocks } from '@liveblocks/node'
import { ConvexHttpClient } from 'convex/browser'

export async function POST(request : Request) {
    const authorization = await auth();
    const user = await currentUser();

    if(!user || !authorization.orgId) {
        return new Response('Unauthorized', {status : 403})
    }

    if (!process.env.NEXT_PUBLIC_CONVEX_URL || !process.env.LIVEBLOCKS_SECRET) {
        return new Response('Server misconfigured', {status : 500})
    }

    const { room } = await request.json().catch(() => ({}))
    const token = await authorization.getToken({ template : "convex" })

    if(typeof room !== "string" || !token) {
        return new Response('Unauthorized', {status : 403})
    }

    const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL)
    convex.setAuth(token)

    const liveblocks = new Liveblocks({
        secret : process.env.LIVEBLOCKS_SECRET
    })

    // Convex only returns the board to members of its organization.
    const board = await convex.query(api.board.get, { id : room });

    if(!board || board.orgId !== authorization.orgId) {
        return new Response('Unauthorized', {status : 403})
    }

    const userInfo = {
        name : user.firstName || "Teammate",
        picture : user.imageUrl
    }

    const session = liveblocks.prepareSession(user.id, {
        userInfo
    })

    session.allow(room, session.FULL_ACCESS)

    const { status, body } = await session.authorize();

    return new Response(body, {status})
}
