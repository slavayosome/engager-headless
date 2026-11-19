import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "@engager/common/errors";
import { withOrg, type Tx } from "@engager/database/tenant";
import { getCampaign } from "../../../operations/campaigns";
import { startCampaign } from "../../../operations/startCampaign";
import { preparePatchOn, readPatchState, startPatchFor } from "../../../strategy/patch";
import type { McpCtx } from "../../context";

const dialog = `on run argv
  set answer to display dialog (item 1 of argv) with title "Engager — Start campaign" buttons {"Cancel", "Start campaign"} default button "Cancel" giving up after 90
  return ((gave up of answer is false) and (button returned of answer is "Start campaign"))
end run`;

/** Installed on local stdio only. The tool has no input for answering the owner's dialog. */
export async function confirmMacStart(message: string, signal: AbortSignal): Promise<boolean> {
  if (process.platform !== "darwin") throw new AppError("owner_confirmation_unavailable", "Open the local MCP server on your Mac to confirm Start.", 409);
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-e", dialog, "--", message], { signal, timeout: 95_000 });
    return stdout.trim() === "true";
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.message.includes("(-128)"))) return false;
    throw new AppError("owner_confirmation_unavailable", "Engager could not show the Start dialog in your Mac session.", 409);
  }
}

async function reviewStart(tx: Tx, campaignId: number, lock: boolean) {
  const state = await readPatchState(tx, campaignId, { lock });
  if (!state.notStarted || (await getCampaign(tx, campaignId))?.status !== "paused") {
    throw new AppError("campaign_not_draft", "Only a paused campaign awaiting its first Start can start here.", 409);
  }
  const version = state.active.version;
  const patch = startPatchFor(campaignId, version, "Start from the owner's agent");
  const { title, rows } = preparePatchOn(state, patch, Date.now());
  const message = [title, `Campaign #${campaignId} · draft ${version}`, ...rows.map(row => `${row.label}: ${row.after}`)].join("\n");
  return { version, message };
}

export async function requestCampaignStart(ctx: McpCtx, campaignId: number, signal: AbortSignal) {
  if (!ctx.confirmStart) throw new AppError("owner_confirmation_unavailable", "Request Start through the local Engager MCP server on your Mac.", 409);
  const reviewed = await withOrg(ctx.organizationId, tx => reviewStart(tx, campaignId, false));
  if (!await ctx.confirmStart(reviewed.message, signal) || signal.aborted) return { campaignId, started: false };
  return withOrg(ctx.organizationId, async tx => {
    const current = await reviewStart(tx, campaignId, true);
    if (current.version !== reviewed.version || current.message !== reviewed.message) {
      throw new AppError("strategy_conflict", "The campaign changed during confirmation. Review the new Start request.", 409);
    }
    signal.throwIfAborted();
    const { result } = await startCampaign(tx, campaignId, current.version, {
      confirmed: true, now: Date.now(), approver: "owner:local-mac", instruction: "Start from the owner's agent",
    });
    return { campaignId, started: result.started, version: result.version };
  });
}
