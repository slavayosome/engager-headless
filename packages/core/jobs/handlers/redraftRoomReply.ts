import { withOrg } from "@engager/database/tenant";
import { failRoomReplyRedraft, redraftRoomReply, type RoomRedraftPayload } from "../../rooms/replyRedraft";
import { trackDraftDelivered } from "../../telemetry/emit";
import { jobGuardedLlm } from "../providerGuard";
import type { SelfScopedCtx } from "../worker";

export async function handleRedraftRoomReply(ctx: SelfScopedCtx, payload: RoomRedraftPayload) {
  const started = Date.now();
  let completed = false;
  try {
    completed = await redraftRoomReply({ organizationId: ctx.organizationId, llm: jobGuardedLlm(ctx), signal: ctx.signal }, payload);
    return { redrafted: completed ? 1 : 0 };
  } finally {
    if (!completed) await withOrg(ctx.organizationId, (tx) => failRoomReplyRedraft(tx, payload));
    trackDraftDelivered({ kind: "redraft", outcome: completed ? "ok" : "failed", durationMs: Date.now() - started });
  }
}
