import { Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";

type Ctx = QueryCtx | MutationCtx;

export async function requireIdentity(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    throw new Error("Unauthorized");
  }

  return identity;
}

// The active organization comes from the `org_id` claim of the Clerk "convex"
// JWT template ("org_id": "{{org.id}}"), never from client-supplied arguments.
export async function requireOrg(ctx: Ctx, orgId: string) {
  const identity = await requireIdentity(ctx);

  if (!orgId || identity.org_id !== orgId) {
    throw new Error("Unauthorized");
  }

  return identity;
}

export async function requireBoard(ctx: Ctx, id: Id<"boards">) {
  const board = await ctx.db.get(id);

  if (!board) {
    throw new Error("Board not found");
  }

  const identity = await requireOrg(ctx, board.orgId);

  return { board, identity };
}
