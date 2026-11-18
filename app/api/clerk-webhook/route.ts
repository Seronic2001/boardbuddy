import { revocationFor, revokeSyncAccess, syncAdminUrl } from '@/lib/sync/revoke'
import { verifyWebhook } from '@clerk/nextjs/webhooks'
import type { NextRequest } from 'next/server'

// Clerk webhook (signed with CLERK_WEBHOOK_SIGNING_SECRET). Subscribe it to
// organizationMembership.deleted, organization.deleted and user.deleted. Removed members
// are disconnected from the sync server at once; a non-2xx reply makes Clerk retry.

export async function POST(request : NextRequest) {
    let evt
    try {
        evt = await verifyWebhook(request)
    } catch {
        return new Response('Invalid signature', { status : 400 })
    }

    const revocation = revocationFor(evt)
    if (!revocation) {
        return new Response('Ignored', { status : 200 })
    }

    const privateKey = process.env.SYNC_PRIVATE_KEY
    const adminUrl = syncAdminUrl({
        SYNC_ADMIN_URL : process.env.SYNC_ADMIN_URL,
        NEXT_PUBLIC_SYNC_URL : process.env.NEXT_PUBLIC_SYNC_URL,
    })
    if (!privateKey || !adminUrl) {
        return new Response('Server misconfigured', { status : 500 })
    }

    try {
        const { disconnected } = await revokeSyncAccess(revocation, { privateKey, adminUrl })
        return Response.json({ ok : true, disconnected })
    } catch (err) {
        console.error('Sync revocation failed', err)
        return new Response('Sync server unavailable', { status : 502 })
    }
}
