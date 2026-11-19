import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpCtx } from "../mcp/context";
import type { ComposerBox } from "../composer/drafts";
import { parseRef } from "../mcp/v2/refs";
import { errorResult, jsonResult } from "../mcp/tools/util";

export const DRAFT_COMMENT = "draft_comment";

/** Writes one comment for a post, on the owner's behalf of the chat agent. */
export type CommentDrafter = (postId: number, signal: AbortSignal) => Promise<string>;

/**
 * The chat's one way to word a comment: the draft dispatcher plans, writes and
 * judges it through the chat agent (`runCommentWords`), and the admitted text
 * is all that comes back. Nothing is saved or sent; a draft the judge
 * withholds comes back as a refusal with the reason.
 */
export function registerDraftCommentTool(server: McpServer, _ctx: McpCtx, draft: CommentDrafter) {
  server.registerTool(DRAFT_COMMENT, {
    title: "Draft a comment",
    description: "Write one comment on a post, in the owner's voice, through Engager's draft dispatcher. Returns the comment's text only; nothing is saved or sent. For any comment draft, call this: never write the comment yourself.",
    inputSchema: { ref: z.string().min(1).max(400) },
  }, async (input, extra) => {
    try {
      const ref = parseRef(input.ref, ["post"]);
      if (ref.kind !== "post") throw new Error("unreachable");
      return jsonResult({ text: await draft(ref.id, extra.signal) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), { code: "draft_withheld", status: 409 });
    }
  });
}

export const DRAFT_MESSAGE = "draft_message";

/** The boxes a message is worded for: a DM, an invite's note, a reply. */
export type MessageBox = Extract<ComposerBox, { kind: "dm" | "invite" | "reply" }>;

/** Writes one message for a box, on the owner's behalf of the chat agent. */
export type MessageDrafter = (box: MessageBox, signal: AbortSignal) => Promise<string>;

/**
 * The chat's one way to word a DM, an invite's note or a reply: the draft
 * dispatcher plans, writes and judges it on its own surface through the chat
 * agent, and the admitted text is all that comes back. Nothing is saved or
 * sent; words the judge withholds come back as a refusal with the reason.
 */
export function registerDraftMessageTool(server: McpServer, _ctx: McpCtx, draft: MessageDrafter) {
  server.registerTool(DRAFT_MESSAGE, {
    title: "Draft a message",
    description: "Write one DM, invite note or reply for a box (box:dm:<conversation>, box:invite:<person>, box:reply:<incoming>), in the owner's voice, through Engager's draft dispatcher. Returns the text only; nothing is saved or sent. For any such draft, call this: never write the words yourself. A DM to a connection with no messages yet is worded as the first message. Refused with dm_not_connected while Engager's last read shows them not connected: say when Engager next checks (the wait's lookAt), and that the owner can press Check LinkedIn now in their Messages if they already accepted.",
    inputSchema: { ref: z.string().min(1).max(400) },
  }, async (input, extra) => {
    try {
      const ref = parseRef(input.ref, ["box"]);
      if (ref.kind !== "box" || (ref.box.kind !== "dm" && ref.box.kind !== "invite" && ref.box.kind !== "reply")) {
        throw new Error("draft_message takes box:dm:, box:invite: or box:reply: refs");
      }
      return jsonResult({ text: await draft(ref.box, extra.signal) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), { code: "draft_withheld", status: 409 });
    }
  });
}

export const DRAFT_IN_BOX = "draft_in_box";

/** Writes another version of the draft a conversation is about, into its box. */
export type BoxDrafter = (instruction: string, signal: AbortSignal) => Promise<string>;

/**
 * Another version of the draft a conversation opened for: written through the
 * same words-only turn as the first and landed on the same angle of the
 * owner's box (`chat/broker.ts`), where the owner's own edits keep their place.
 * Mounted only in a conversation a draft opened, so it names no box: that
 * conversation's box is the only one it writes in.
 */
export function registerDraftInBoxTool(server: McpServer, _ctx: McpCtx, draft: BoxDrafter) {
  server.registerTool(DRAFT_IN_BOX, {
    title: "Draft another version in the box",
    description: "This conversation is about one draft in the owner's box. Write another version of it, doing what the owner asked, and put it in their box as the newest version; nothing is approved, queued or sent. Pass instruction: what the owner asked to change, in their words. Call it once per owner message, even when the version misses part of what they asked: say what it missed instead. Returns the new version's text, which the chat shows as that version, so answer in one short line without repeating it. Every new version of this draft goes through this tool: never draft_comment or draft_message for it, and never words you write yourself.",
    inputSchema: { instruction: z.string().min(1).max(2000) },
  }, async (input, extra) => {
    try {
      return jsonResult({ text: await draft(input.instruction, extra.signal) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), { code: "draft_withheld", status: 409 });
    }
  });
}
