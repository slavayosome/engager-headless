import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { mcpAppCardSessions } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * Which rendered card owns a surface right now.
 *
 * A conversation accumulates cards — every render appends another copy below
 * the last, and each one keeps polling and accepting clicks. Instead of trying
 * to stop cards from being rendered, the newest one owns the surface and the
 * older ones collapse when they notice.
 *
 * A render MINTS a grant — the card's identity and a monotonic sequence,
 * embedded in the render payload — but minting does not transfer the surface.
 * Not every bound tool call becomes a visible card: subagent and
 * background-task calls, compaction re-reads, and status probes the model
 * shouldn't make all reach the same tool and render nothing. Under the old
 * claim-at-render rule any of those collapsed every real deck against a card
 * that never existed. So the surface changes hands only at ADOPTION: the
 * granted card mounts and its first probe promotes it. A grant nobody mounts
 * is inert — the next render simply overwrites it.
 *
 * Render order still decides between real cards: a newer mint overwrites the
 * older grant, so a slow-mounting older card can never promote (the bug the
 * previous design fixed stays fixed). And a card only ever stands down against
 * an ADOPTED newer card — never against a bare grant — so a supersession bug
 * cannot collapse the only deck the owner has.
 *
 * Widget-initiated calls carry a cardId and are PROBES. The one legacy path:
 * a bundle from before render grants self-mints its id and expects its first
 * probe to register it, so a card with no held sequence may adopt a surface
 * no card has ever mounted on.
 */

/** Widget view name for the draft review queue. */
export const BATCH_REVIEW_CARD_SURFACE = "batch-review";

/**
 * Where the claim travels when a tool's body cannot carry it.
 *
 * `list_activity` returns a bare array that the model and the skills both read
 * positionally; wrapping it to carry one widget-only field would break every
 * non-card caller. `_meta` is invisible to the model and ignorable by non-Apps
 * hosts, so the card reads its claim there instead.
 */
export const CARD_SESSION_META_KEY = "engager/cardSession";

export type CardSession = {
  activeCardId: string;
  claimSeq: number;
};

type ProbeOpts = {
  now?: number;

};

/**
 * A model/user-initiated call MAY be rendering a new card: mint its identity
 * and sequence in one atomic upsert and embed the grant in the render payload.
 * The surface itself does not change hands here — if the host mounts the card,
 * its first probe promotes the grant; if it never mounts (a subagent call, a
 * background task, a collapsed result), the grant sits inert until the next
 * mint overwrites it. Two concurrent renders serialize on the row, so they can
 * never share a sequence — the transaction that commits later holds the
 * higher one.
 */
export async function claimSurfaceForRender(
  tx: Tx,
  surface: string,
  now = Date.now(),
): Promise<CardSession> {
  const cardId = randomUUID();
  const [row] = await tx
    .insert(mcpAppCardSessions)
    .values({ surface, cardId, claimSeq: 1, claimedAt: now })
    .onConflictDoUpdate({
      target: [mcpAppCardSessions.organizationId, mcpAppCardSessions.surface],
      set: {
        cardId,
        claimSeq: sql`${mcpAppCardSessions.claimSeq} + 1`,
        claimedAt: now,
      },
    })
    .returning({
      cardId: mcpAppCardSessions.cardId,
      claimSeq: mcpAppCardSessions.claimSeq,
    });
  if (!row) throw new Error(`card surface ${surface} was not claimed`);
  return { activeCardId: row.cardId, claimSeq: row.claimSeq };
}

/**
 * A mounted card asking who owns the surface.
 *
 * - The adopted holder gets its own session back.
 * - The card holding the LATEST grant promotes on its first probe — adoption
 *   is the moment the surface changes hands and every other card starts
 *   standing down.
 * - A card with no held sequence may adopt a surface no card has ever mounted
 *   on — the compat path for pre-grant bundles that self-mint their ids.
 * - Any other card is told who is actually on screen: the adopted holder if
 *   one exists, otherwise itself — a bare grant never collapses anyone.
 * - An empty surface (nothing ever rendered) accepts a legacy self-claim at
 *   sequence 1.
 */
export async function probeCardSession(
  tx: Tx,
  surface: string,
  cardId: string,
  heldSeq: number | null = null,
  opts: ProbeOpts = {},
): Promise<CardSession> {
  const now = opts.now ?? Date.now();
  const [existing] = await tx
    .select()
    .from(mcpAppCardSessions)
    .where(eq(mcpAppCardSessions.surface, surface))
    .for("update");

  if (!existing) {
    await tx
      .insert(mcpAppCardSessions)
      .values({
        surface,
        cardId,
        claimSeq: 1,
        claimedAt: now,
        adoptedCardId: cardId,
        adoptedClaimSeq: 1,
        adoptedAt: now,
      })
      .onConflictDoNothing();
    const [claimed] = await tx
      .select()
      .from(mcpAppCardSessions)
      .where(eq(mcpAppCardSessions.surface, surface));
    // Lost the insert race to another adopter: report them. Lost it to a bare
    // mint: fail open — a grant nobody mounted collapses no one.
    return claimed?.adoptedCardId != null
      ? {
          activeCardId: claimed.adoptedCardId,
          claimSeq: claimed.adoptedClaimSeq ?? claimed.claimSeq,
        }
      : { activeCardId: cardId, claimSeq: claimed?.claimSeq ?? 1 };
  }

  if (existing.adoptedCardId === cardId) {
    return {
      activeCardId: cardId,
      claimSeq: existing.adoptedClaimSeq ?? existing.claimSeq,
    };
  }

  if (
    existing.cardId === cardId ||
    (existing.adoptedCardId == null && heldSeq == null)
  ) {
    await tx
      .update(mcpAppCardSessions)
      .set({
        adoptedCardId: cardId,
        adoptedClaimSeq: existing.claimSeq,
        adoptedAt: now,
      })
      .where(
        and(
          eq(mcpAppCardSessions.surface, surface),
          eq(mcpAppCardSessions.claimSeq, existing.claimSeq),
        ),
      );
    return { activeCardId: cardId, claimSeq: existing.claimSeq };
  }

  if (existing.adoptedCardId != null) {
    return {
      activeCardId: existing.adoptedCardId,
      claimSeq: existing.adoptedClaimSeq ?? existing.claimSeq,
    };
  }

  // Nothing has ever mounted here and this card holds an older grant: fail
  // open. It stands down when — and only when — a granted card really mounts.
  return { activeCardId: cardId, claimSeq: heldSeq ?? existing.claimSeq };
}

/**
 * A collapsed card's user clicked "Bring this deck back": bump the claim to
 * THAT card's id and adopt it in the same stroke — the user clicking IS the
 * mount proof. The reclaiming card becomes the newest adopted claim, so every
 * other card stands down on its next probe and the one-live-card invariant
 * holds.
 */
export async function reclaimCardSurface(
  tx: Tx,
  surface: string,
  cardId: string,
  opts: ProbeOpts = {},
): Promise<CardSession> {
  const now = opts.now ?? Date.now();
  const [row] = await tx
    .insert(mcpAppCardSessions)
    .values({
      surface,
      cardId,
      claimSeq: 1,
      claimedAt: now,
      adoptedCardId: cardId,
      adoptedClaimSeq: 1,
      adoptedAt: now,
    })
    .onConflictDoUpdate({
      target: [mcpAppCardSessions.organizationId, mcpAppCardSessions.surface],
      set: {
        cardId,
        claimSeq: sql`${mcpAppCardSessions.claimSeq} + 1`,
        claimedAt: now,
        adoptedCardId: cardId,
        adoptedClaimSeq: sql`${mcpAppCardSessions.claimSeq} + 1`,
        adoptedAt: now,
      },
    })
    .returning({
      cardId: mcpAppCardSessions.cardId,
      claimSeq: mcpAppCardSessions.claimSeq,
    });
  if (!row) throw new Error(`card surface ${surface} was not reclaimed`);
  return { activeCardId: row.cardId, claimSeq: row.claimSeq };
}

/**
 * Who is actually on screen, without claiming or adopting anything. Reports
 * only an ADOPTED holder — a minted grant nobody mounted is invisible here,
 * so action fencing and origin checks never refuse a live deck over a card
 * that doesn't exist.
 */
export async function readCardSession(
  tx: Tx,
  surface: string,
): Promise<CardSession | null> {
  const [row] = await tx
    .select()
    .from(mcpAppCardSessions)
    .where(and(eq(mcpAppCardSessions.surface, surface)));
  return row?.adoptedCardId != null
    ? {
        activeCardId: row.adoptedCardId,
        claimSeq: row.adoptedClaimSeq ?? row.claimSeq,
      }
    : null;
}
