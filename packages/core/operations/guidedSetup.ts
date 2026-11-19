import { and, desc, eq, or, sql } from "drizzle-orm";
import { track } from "@engager/observability/analytics";
import { AppError } from "@engager/common/errors";
import {
  channels,
  jobs,
  messages,
  organizations,
  products,
  voiceSamples,
} from "@engager/database/schema";
import { afterCommit, type Tx } from "@engager/database/tenant";
import { materializeVaultMirror } from "../brain/mirror";
import { listNotes } from "../brain/vault";
import { linkedInConnectionState } from "../linkedin/liveness";
import { runtimeInstanceId } from "../execution/authority";
import { DEFAULT_NETWORK } from "../network/registry";
import { enqueue, retireFinishedIdempotencyKey } from "../jobs/queue";
import { parseFirstCampaignDraft, type FirstCampaignDraft } from "./firstCampaignDraft";
import { firstCampaignReceipt } from "./firstCampaignReceipt";

export type GuidedSetupState = {
  step: "linkedin" | "product" | "campaign" | "done";
  accountId: string | null;
  accountName: string | null;
  connected: boolean;
  /** The owner said "that's me" to the connected account (`startGuidedBrainImport`
   *  is that yes). Until then it is only what Engager's browser happens to be
   *  signed in as, and may still be sent away (`releaseUnconfirmedAccount`). */
  accountConfirmed: boolean;
  /** Durable Not me marker; no name/headline/profile is retained. */
  rejectedAccountId?: string | null;
  brainStatus: "idle" | "queued" | "running" | "done" | "failed";
  products: { id: number; name: string; oneLiner: string | null }[];
  /** The first campaign's answers so far (US-ONG-01), or null before any. */
  campaignDraft: FirstCampaignDraft | null;
  /** The sole campaign whose Strategy may be opened to recover setup. */
  recoveryCampaignId?: number | null;
  /** Finished setup lands in this campaign’s Inbox, including reloads. */
  completedCampaignId?: number | null;
};

/** A guided-setup refusal written FOR the owner, so the screen that asked can
 *  show it instead of its own generic copy. */
export class GuidedSetupError extends AppError {
  constructor(message: string) {
    super("guided_setup_unavailable", message, 409);
  }
}

function importKey(orgId: string, accountId: string) {
  return `setup:brain:${orgId}:${accountId}`;
}

/** Past the owner's yes: the steps after the LinkedIn one. */
function accountConfirmed(step: string | null | undefined): boolean {
  return step === "product" || step === "campaign" || step === "done";
}

/** All progress comes from durable state. No model, browser probe or hidden
 * job creation belongs in a status poll. */
export async function readGuidedSetup(
  tx: Tx,
  orgId: string,
): Promise<GuidedSetupState> {
  const connection = await linkedInConnectionState(tx);
  const connected =
    connection.connected && connection.externalAccountId !== null;
  const [org] = await tx
    .select({ step: organizations.onboardingStep, campaignDraft: organizations.firstCampaignDraft, rejectedAccountId: organizations.rejectedLinkedinAccountId })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const [job] = connection.externalAccountId
    ? await tx
        .select({ status: jobs.status })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, orgId),
            eq(
              jobs.idempotencyKey,
              importKey(orgId, connection.externalAccountId),
            ),
          ),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(1)
    : [];
  const step =
    org?.step === "done"
      ? "done"
      : !connected
        ? "linkedin"
        : org?.step === "campaign"
          ? "campaign"
          : org?.step === "product"
            ? "product"
            : "linkedin";
  const campaignDraft = parseFirstCampaignDraft(org?.campaignDraft);
  return {
    step,
    connected,
    accountConfirmed: accountConfirmed(org?.step),
    rejectedAccountId: org?.rejectedAccountId ?? null,
    accountId: connection.externalAccountId,
    accountName: connection.accountName,
    brainStatus: !job
      ? "idle"
      : job.status === "dead" || job.status === "failed"
        ? "failed"
        : job.status,
    products: campaignDraft?.productId === null ? [] : await tx
      .select({
        id: products.id,
        name: products.name,
        oneLiner: products.oneLiner,
      })
      .from(products)
      .where(campaignDraft?.productId === undefined ? undefined : eq(products.id, campaignDraft.productId))
      .orderBy(desc(products.id)),
    campaignDraft,
    recoveryCampaignId: step === "campaign" ? (await firstCampaignReceipt(tx))?.id ?? null : null,
    completedCampaignId: step === "done" ? (await firstCampaignReceipt(tx))?.id ?? null : null,
  };
}

/** Lock the org so double clicks cannot create two products, Scouts or imports.
 * Every mutation rechecks the account the owner saw, including after inference. */
export async function lockGuidedSetup(
  tx: Tx,
  orgId: string,
  expectedAccount: string,
) {
  const [org] = await tx
    .select({ step: organizations.onboardingStep })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for("update");
  if (!org) throw new GuidedSetupError("This installation is not ready yet.");
  const connection = await linkedInConnectionState(tx);
  if (
    !connection.connected ||
    connection.externalAccountId !== expectedAccount
  ) {
    throw new GuidedSetupError(
      "The LinkedIn connection changed. Reconnect and continue with the current account.",
    );
  }
  return org;
}

/** Whether anything the LinkedIn step's yes makes exists for the account: the
 *  Brain import, a LinkedIn-learned note, a voice sample, any message. Legacy
 *  imports may name a display name or `self`, so all hold the one channel. */
async function holdsWorkFor(tx: Tx, orgId: string, accountId: string) {
  const [job] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, orgId),
        or(
          sql`${jobs.payload}->>'expectedAccountId' = ${accountId}`,
          and(eq(jobs.type, "seed_brain"), sql`${jobs.payload}->>'provenance' LIKE 'linkedin:%'`),
        ),
      ),
    )
    .limit(1);
  // The LinkedIn import writes vault notes, so the vault is where a note
  // learned from LinkedIn shows. On a replica the files follow the mirror's
  // rows, so bring the vault to that version before reading it.
  await materializeVaultMirror(tx);
  const note = (await listNotes()).find((n) => n.source === "linkedin");
  const [sample] = await tx.select({ id: voiceSamples.id }).from(voiceSamples).limit(1);
  const [message] = await tx.select({ id: messages.id }).from(messages).limit(1);
  return Boolean(job ?? note ?? sample ?? message);
}

/**
 * "Not me": the account Engager's browser was signed in as is not the owner's,
 * so its provisional binding and profile text are removed. Only the public
 * identifier remains as a rejection marker when the owner explicitly rejects it. A probe binds the first account it sees at once (`observeAccount`); the
 * owner's yes (`startGuidedBrainImport`) is what makes that binding theirs, so
 * until then it is the one binding that may be released.
 *
 * Refused, with nothing changed, once the owner confirmed it, once the binding
 * left this installation, or once anything holds the account's work: a job, a
 * message, a vault note learned from LinkedIn or a voice sample. Work started
 * outside guided setup
 * must keep its binding too.
 */
export async function releaseUnconfirmedAccount(
  tx: Tx,
  orgId: string,
  accountId: string,
  options: { rememberRejection?: boolean } = {},
) {
  const [org] = await tx
    .select({ step: organizations.onboardingStep, rejectedAccountId: organizations.rejectedLinkedinAccountId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for("update");
  if (!org) throw new GuidedSetupError("This installation is not ready yet.");
  if (accountConfirmed(org.step)) {
    throw new GuidedSetupError("That account is already confirmed.");
  }
  const [channel] = await tx
    .select({
      id: channels.id,
      executionAccountId: channels.executionAccountId,
      executionEpoch: channels.executionEpoch,
      executionRuntimeId: channels.executionRuntimeId,
      executionPlacement: channels.executionPlacement,
      executionState: channels.executionState,
      executionHolder: channels.executionHolder,
      executionTransferId: channels.executionTransferId,
    })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .for("update");
  // A lost response after the local transaction committed is safe to replay.
  if (channel?.executionAccountId === null && org.rejectedAccountId === accountId) return;
  if (
    !channel ||
    channel.executionAccountId !== accountId ||
    channel.executionEpoch < 1 ||
    channel.executionRuntimeId !== runtimeInstanceId() ||
    channel.executionPlacement !== "local" ||
    (channel.executionState !== "active" && channel.executionState !== "paused_recovery") ||
    channel.executionHolder !== null ||
    channel.executionTransferId !== null
  ) {
    throw new GuidedSetupError(
      "The LinkedIn connection changed. Check again to see who is signed in now.",
    );
  }
  if (await holdsWorkFor(tx, orgId, accountId)) {
    throw new GuidedSetupError(
      "Engager already holds work for that account, so it cannot be set aside from here.",
    );
  }
  await tx
    .update(channels)
    .set({
      externalAccountId: null,
      executionAccountId: null,
      executionRuntimeId: null,
      executionPlacement: null,
      displayName: null,
      verifiedAt: null,
      sessionOkAt: null,
      sessionReason: null,
      executionEpoch: 0,
      executionState: "paused_recovery",
      updatedAt: Date.now(),
    })
    .where(eq(channels.id, channel.id));
  if (options.rememberRejection !== false) {
    await tx.update(organizations).set({ rejectedLinkedinAccountId: accountId })
      .where(eq(organizations.id, orgId));
  }
}

export async function startGuidedBrainImport(
  tx: Tx,
  orgId: string,
  accountId: string,
  retry = false,
) {
  const org = await lockGuidedSetup(tx, orgId, accountId);
  const key = importKey(orgId, accountId);
  if (retry) await retireFinishedIdempotencyKey(tx, orgId, key);
  await enqueue(tx, {
    type: "seed_brain",
    idempotencyKey: key,
    maxAttempts: 2,
    payload: {
      source: { kind: "linkedin" },
      scope: { kind: "brain" },
      expectedAccountId: accountId,
      provenance: `linkedin:${accountId}`,
    },
  });
  if (org.step !== "done" && org.step !== "campaign") {
    await tx
      .update(organizations)
      .set({ onboardingStep: "product", rejectedLinkedinAccountId: null, updatedAt: Date.now() })
      .where(eq(organizations.id, orgId));
    // Only the first time the step moves: a retried import changes nothing.
    if (org.step !== "product") {
      afterCommit(tx, () => track("onboarding_step_completed", { step: "linkedin" }));
    }
  }
}

export async function advanceGuidedSetup(
  tx: Tx,
  orgId: string,
  accountId: string,
) {
  const org = await lockGuidedSetup(tx, orgId, accountId);
  if (org.step === "done") return;
  await tx
    .update(organizations)
    .set({ onboardingStep: "campaign", updatedAt: Date.now() })
    .where(eq(organizations.id, orgId));
  if (org.step !== "campaign") {
    afterCommit(tx, () => track("onboarding_step_completed", { step: "product" }));
  }
}

/**
 * BACK FROM THE CAMPAIGN STEP to the product it follows: the step moves back
 * one, and nothing else does. What the owner typed on the campaign screens is
 * the wizard's working copy and stays where it is, so coming forward again
 * finds the line as it was. A step that is not the campaign's is left alone.
 */
export async function reopenGuidedProduct(
  tx: Tx,
  orgId: string,
  accountId: string,
) {
  const org = await lockGuidedSetup(tx, orgId, accountId);
  if (org.step !== "campaign") return;
  await tx
    .update(organizations)
    .set({ onboardingStep: "product", updatedAt: Date.now() })
    .where(eq(organizations.id, orgId));
}
