import type { ConversationEventRow, ConversationEventType } from "@engager/database/schema";
import { untrusted } from "../ai/prompts";

/** What each kind of observed words is called inside its fence. */
const LABELS: Partial<Record<ConversationEventType, string>> = {
  reply_observed: "REPLY UNDER OUR COMMENT",
  reply_edited: "REPLY UNDER OUR COMMENT (EDITED)",
  inbound_message_observed: "DIRECT MESSAGE",
  dm_confirmed: "OUR DIRECT MESSAGE (this account sent it)",
};

/**
 * THE path from a conversation event's words into a model's context — a prompt
 * builder and an MCP read alike (spec §18 R16, INV-30). A person's reply, an
 * invitation note or a DM is data: fenced and labelled as untrusted, so
 * nothing in it can read as an instruction, change a setting or reach another
 * conversation. Nothing renders `content` any other way.
 */
export function delimited(
  event: Pick<ConversationEventRow, "type" | "content">,
): string {
  return untrusted(LABELS[event.type] ?? "OBSERVED CONTENT", event.content ?? "");
}
