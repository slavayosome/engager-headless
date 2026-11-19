import type { Tx } from "@engager/database/tenant";
import { inheritedStrategies, inheritedGroup } from "../strategy/inherit";
import { DEFAULT_RETENTION } from "../strategy/seed";
import {
  DEFAULT_DM_POLICY,
  DEFAULT_ELIGIBILITY,
  type DmPolicy,
  type EligibilityPolicy,
} from "./eligibility";

/** What a conversation event on one campaign is judged and kept by. */
export type ConversationPolicy = {
  eligibility: EligibilityPolicy;
  dm: DmPolicy;
  retention: { content_days: number; audit_days: number };
  /** The strategy versions the groups came from; null where that scope
   *  has no active version. */
  versions: { campaign: number | null; account: number | null };
};

/** One campaign's eligibility, DM and retention groups, inherited the way the
 *  resolver inherits a mode: its own active strategy, else its account
 *  default's, else the constants — which are all a conversation whose owning
 *  campaign was deleted has left. */
export async function conversationPolicy(
  tx: Tx,
  campaignId: number | null,
): Promise<ConversationPolicy> {
  const strategies =
    campaignId === null
      ? undefined
      : (await inheritedStrategies(tx, [campaignId])).get(campaignId);
  return {
    eligibility: inheritedGroup(strategies, "eligibility") ?? DEFAULT_ELIGIBILITY,
    dm: inheritedGroup(strategies, "dm") ?? DEFAULT_DM_POLICY,
    retention: inheritedGroup(strategies, "retention") ?? DEFAULT_RETENTION,
    versions: {
      campaign: strategies?.campaign?.version ?? null,
      account: strategies?.account?.version ?? null,
    },
  };
}
