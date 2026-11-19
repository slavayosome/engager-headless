import type { Tx } from "@engager/database/tenant";
import { listKnowledge } from "../brain/knowledge";
import { linkedInConnectionState } from "../linkedin/liveness";
import { getProfile } from "../profile";
import { strategyInForce } from "../strategy/read";
import { listCampaigns } from "./campaigns";
import { listWorkers } from "./workers";

/** What the owner has once setup is done, read off the server on the way out
 *  so an agent never retells it from memory. */
export async function setupHandoff(tx: Tx) {
  const [campaign] = await listCampaigns(tx);
  const scout = (await listWorkers(tx)).find((worker) => worker.type === "scout");
  const profile = await getProfile(tx);
  return {
    accountName: (await linkedInConnectionState(tx)).accountName ?? null,
    campaign: campaign
      ? { id: campaign.id, name: campaign.name, objective: campaign.objective, notStarted: !(await strategyInForce(tx, campaign.id)) }
      : null,
    scout: scout ? { workerId: scout.id, name: scout.name, auto: scout.auto } : null,
    brainNotes: (await listKnowledge(tx)).length,
    voiceLearned: Boolean(profile.voicePersona?.trim()),
  };
}
