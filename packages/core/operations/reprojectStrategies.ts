import { and, asc, eq, isNull } from "drizzle-orm";
import { db as baseDb } from "@engager/database";
import { campaignStrategies, campaigns, organizations, systemState } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { activateStrategy } from "../strategy/activate";
import { createHash } from "node:crypto";
import { STRATEGY_SCHEMA_VERSION } from "../strategy/contract";
import { stricterMode, upgradeStrategy, currentDocument } from "../strategy/upgrade";

/** What an organization's stamp must equal for its versions to be left alone:
 *  the document schema plus the code that reads an older one as today's. A
 *  change to either (a bump, or an edit to `strategy/upgrade.ts`) differs
 *  from every stored stamp, so no reading change can skip a projection it
 *  needs; so does a rollback, whose stamp is another build's. */
const PROJECTION_STAMP = createHash("sha256")
  .update([STRATEGY_SCHEMA_VERSION, stricterMode, upgradeStrategy, currentDocument].map(String).join("\n"))
  .digest()
  .readUInt32BE(0) & 0x7fffffff;

/**
 * Project every version in force when the document schema advances.
 *
 * A version stored in an older schema already reads as today's wherever it is
 * read (`strategy/upgrade.ts`): each action takes the stricter of its step's
 * mode and the campaign's. What the runtime reads, though, is the switches
 * that version was activated into, and those are the older reading's. So each
 * campaign with a version in force is activated again in place
 * (`activateStrategy`, the version in force and no other) with its
 * projection held to what its rows already say (`narrowOnly`): a mode the
 * upgrade lowered is lowered on the worker rows, and nothing that was off —
 * disarmed by a kill switch, suspended, never armed — comes on.
 *
 * Nothing is written to `campaign_strategies`: no version, no provenance. A
 * stored document stays in the schema it was written in until the owner's next
 * change to it, which is why a release that has to be rolled back still reads
 * every one (0.3.39's contract takes schema 2 alone). That includes the
 * account default: it carries no mode of its own to fold, every campaign on
 * the account resolves through it as it is read, and a default that no longer
 * satisfies the contract refuses the activation of each campaign under it.
 *
 * A campaign not started has no version in force, so nothing to project; its
 * draft reads as today's schema and is projected at the owner's Start. A
 * version waiting for its instant, or waiting for review, is left as it is.
 *
 * One transaction per campaign, behind the campaign row's lock. A failed
 * projection leaves its organization's stamp unchanged, so the next start
 * retries it. A successful pass stamps the current schema for that org.
 *
 * `campaign_strategies` and `campaigns` are RLS-scoped, so the organizations
 * are enumerated on the base db and each is read inside its own `withOrg`, as
 * the scheduler does.
 */

export type StrategyReprojections = {
  /** Campaigns whose version in force was projected again. */
  reprojected: number[];
  stayed: Array<{ campaignId: number; reason: string }>;
};

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function reprojectStrategiesInForce(
  db: typeof baseDb = baseDb,
  now = Date.now(),
): Promise<StrategyReprojections> {
  const out: StrategyReprojections = { reprojected: [], stayed: [] };
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const org of orgs) {
    const stamped = await withOrg(org.id, async (tx) => {
      const [state] = await tx.select({ version: systemState.strategyProjectionSchema }).from(systemState);
      return state?.version ?? 0;
    });
    if (stamped === PROJECTION_STAMP) continue;
    const failuresBefore = out.stayed.length;
    const inForce = await withOrg(org.id, (tx) =>
      tx
        .select({ campaignId: campaigns.id })
        .from(campaigns)
        .innerJoin(campaignStrategies, eq(campaignStrategies.campaignId, campaigns.id))
        .where(
          and(
            isNull(campaigns.deletedAt),
            eq(campaignStrategies.status, "active"),
          ),
        )
        .orderBy(asc(campaigns.id)),
    );
    for (const { campaignId } of inForce) {
      try {
        const projected = await withOrg(org.id, async (tx) => {
          // The campaign row first, the lock every writer of its versions
          // takes; then the version in force now, which a patch or an undo
          // may have replaced since the list above.
          await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).for("update");
          const [active] = await tx
            .select({ version: campaignStrategies.version })
            .from(campaignStrategies)
            .where(and(eq(campaignStrategies.campaignId, campaignId), eq(campaignStrategies.status, "active")));
          if (!active) return false;
          await activateStrategy(tx, { campaignId, version: active.version }, now, { narrowOnly: true });
          return true;
        });
        if (projected) out.reprojected.push(campaignId);
      } catch (error) {
        out.stayed.push({ campaignId, reason: reasonOf(error) });
      }
    }
    if (out.stayed.length === failuresBefore) {
      await withOrg(org.id, (tx) => tx.insert(systemState)
        .values({ organizationId: org.id, strategyProjectionSchema: PROJECTION_STAMP })
        .onConflictDoUpdate({ target: systemState.organizationId, set: { strategyProjectionSchema: PROJECTION_STAMP } }));
    }
  }
  return out;
}
