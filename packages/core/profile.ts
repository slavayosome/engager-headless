import { eq, sql } from "drizzle-orm";
import {
  channels,
  profile,
  voices,
  type Profile,
  type StyleStructuralRange,
  type SurfaceVoice,
  type VoiceCard,
  type VoiceChannels,
  type VoiceSurfaceKey,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { DEFAULT_NETWORK } from "./network/registry";
import { ensureDefaultVoice } from "./voice";

/**
 * The single account-wide profile row (voice shared by all campaigns). The PK is
 * `organization_id`, supplied by the GUC default — so `values({})` inserts the
 * current org's row. RLS scopes the select to (at most) that one row.
 */
export async function getProfile(tx: Tx): Promise<Profile> {
  const [row] = await tx.select().from(profile);
  if (row) return row;
  await tx.insert(profile).values({}).onConflictDoNothing();
  const [created] = await tx.select().from(profile);
  return created!;
}

/** Persist the connected account's display name (naming setup/status surfaces:
 *  "Connected as <name>"). Learned from the account's own posts — never typed.
 *
 *  Identity lives on the channel row: WHO the account is describes ONE account,
 *  and the `profile` singleton it was on describes the org's voice. The single
 *  writer for the account's name — the liveness probe.
 *
 *  An UPDATE, never an upsert: the org's single channel row already exists, and
 *  under the `NULLS NOT DISTINCT` identity key an insert-on-conflict would mint
 *  a second row beside it. RLS supplies the org predicate. */
export async function setChannelDisplayName(
  tx: Tx,
  displayName: string,
): Promise<void> {
  await tx
    .update(channels)
    .set({ displayName, updatedAt: Date.now() })
    .where(eq(channels.network, DEFAULT_NETWORK));
}

/** Persist which channels "Re-learn voice" pulls from (LinkedIn / Brain). */
export async function setVoiceChannels(
  tx: Tx,
  channels: VoiceChannels,
): Promise<void> {
  await tx
    .insert(profile)
    .values({ voiceChannels: channels })
    .onConflictDoUpdate({
      target: profile.organizationId,
      set: { voiceChannels: channels, updatedAt: Date.now() },
    });
}

/** Persist the voice-derived structural style range (writer-variety). Upserts the
 *  singleton profile row AND mirrors onto the org's default Voice row (the
 *  entity store the read path is cutting over to).
 *
 *  LOCK ORDER: default-voice row FIRST, profile row second — the canonical
 *  order for every voices↔profile transaction (see setChannelVoice). This tx
 *  runs concurrently with import_voice's post half, which holds the voice row
 *  (SELECT … FOR UPDATE) while dual-writing the profile row; taking the
 *  profile row first here closed a proven AB/BA deadlock cycle (40P01). */
export async function setProfileStructuralRange(
  tx: Tx,
  range: StyleStructuralRange,
): Promise<void> {
  const def = await ensureDefaultVoice(tx);
  await tx
    .update(voices)
    .set({
      structuralRange: range,
      maturity: sql`case when ${voices.maturity} = 'calibrating' then 'provisional' else ${voices.maturity} end`,
      revision: sql`${voices.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(voices.id, def.id));
  await tx
    .insert(profile)
    .values({ voiceStructuralRange: range })
    .onConflictDoUpdate({
      target: profile.organizationId,
      set: { voiceStructuralRange: range, updatedAt: Date.now() },
    });
}

/** Legacy single-voice setter — now a thin wrapper over the comment channel so
 *  every write path keeps `voices.comment` and the legacy columns in sync. */
export async function setProfileVoice(
  tx: Tx,
  v: { persona?: string; houseStyle?: string; learnedFrom?: number },
): Promise<void> {
  await setChannelVoice(tx, "comment", { ...v, sources: ["manual"] });
}

/** The voice one output surface resolves to, with provenance. */
export type ResolvedVoice = {
  channel: VoiceSurfaceKey;
  persona: string | null;
  houseStyle: string | null;
  learnedFrom: number;
  sources: string[];
  /** true = falling back to the legacy single voice (distilled from posts) —
   *  honest for the post channel, labeled "legacy" for comment. */
  seeded: boolean;
};

/**
 * Resolve the voice for one OUTPUT SURFACE: `voices[channel]` → the legacy flat
 * columns → empty. Existing orgs keep working unchanged until a re-learn writes
 * the channel entry; the post channel's legacy fallback is marked seeded (the
 * legacy voice was distilled FROM posts, so it's an honest post-voice seed).
 */
export function resolveVoice(
  p: Profile,
  channel: VoiceSurfaceKey,
): ResolvedVoice {
  const cv = p.voices?.[channel];
  if (cv && (cv.persona?.trim() || cv.houseStyle?.trim())) {
    return {
      channel,
      persona: cv.persona,
      houseStyle: cv.houseStyle,
      learnedFrom: cv.learnedFrom,
      sources: cv.sources,
      seeded: false,
    };
  }
  return {
    channel,
    persona: p.voicePersona,
    houseStyle: p.voiceHouseStyle,
    learnedFrom: p.voiceLearnedFrom,
    sources: channel === "post" ? ["posts_fallback"] : ["legacy"],
    seeded:
      channel === "post" &&
      !!(p.voicePersona?.trim() || p.voiceHouseStyle?.trim()),
  };
}

/**
 * Write one channel's voice (read-modify-write of the singleton row inside the
 * caller's tx). Comment-channel writes DUAL-WRITE the legacy flat columns —
 * that dual-write is the coherence guarantee for old readers and the fallback;
 * never update voicePersona/voiceHouseStyle directly.
 *
 * LOCK ORDER: default-voice row FIRST, profile row second. Callers that fence
 * on voice maturity (import_voice, calibration applies) already hold the voice
 * row via SELECT … FOR UPDATE before calling in; acquiring the profile row
 * first here handed every UNfenced caller (dashboard saveVoice, linkedinSeed,
 * relearnVoice) the reverse order and a real AB/BA deadlock (40P01) against a
 * concurrent fenced writer. Every voices↔profile tx must take the voice row
 * first — setProfileStructuralRange follows the same rule.
 */
export async function setChannelVoice(
  tx: Tx,
  channel: VoiceSurfaceKey,
  v: {
    persona?: string;
    houseStyle?: string;
    learnedFrom?: number;
    sources?: string[];
    card?: VoiceCard | null;
  },
): Promise<void> {
  const prof = await getProfile(tx);
  const prev = prof.voices?.[channel];
  const next: SurfaceVoice = {
    persona: v.persona !== undefined ? v.persona : (prev?.persona ?? null),
    houseStyle:
      v.houseStyle !== undefined ? v.houseStyle : (prev?.houseStyle ?? null),
    learnedFrom:
      v.learnedFrom !== undefined ? v.learnedFrom : (prev?.learnedFrom ?? 0),
    sources: v.sources ?? prev?.sources ?? ["manual"],
    ...(v.card !== undefined
      ? { card: v.card }
      : prev?.card !== undefined
        ? { card: prev.card }
        : {}),
    updatedAt: Date.now(),
  };
  // COHERENCE SHIM: mirror the write onto the org's default Voice row (the
  // entity store the read path is cutting over to), so every existing write
  // path — import_voice, save_voice, dashboard saveVoice, linkedinSeed —
  // feeds the new store with zero call-site churn. Same atomic per-key merge
  // (the two import_voice halves run in parallel). A later deprecation PR flips
  // readers to the voice row and retires the profile half of this dual-write.
  // A relearn's proposal lives on the voice row alone, and outlives a write of
  // the words beside it: only Keep or Drop settles it
  // (`settleProposedDescription`). Carried over in the same statement, so the
  // per-key merge stays atomic.
  const def = await ensureDefaultVoice(tx);
  await tx
    .update(voices)
    .set({
      channels: sql`coalesce(${voices.channels}, '{}'::jsonb) || jsonb_build_object(${channel}::text, ${JSON.stringify(next)}::jsonb || jsonb_strip_nulls(jsonb_build_object('proposed', ${voices.channels} -> ${channel}::text -> 'proposed')))`,
      ...(channel === "comment" && v.card !== undefined
        ? { card: v.card }
        : {}),
      maturity: sql`case when ${voices.maturity} = 'calibrating' then 'provisional' else ${voices.maturity} end`,
      revision: sql`${voices.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(voices.id, def.id));

  await tx.update(profile).set({
    // ATOMIC per-key merge: the comment and post halves of import_voice write
    // concurrently — a JS read-modify-write of the whole map would let the last
    // writer clobber the other channel's entry (lost update).
    voices: sql`coalesce(${profile.voices}, '{}'::jsonb) || jsonb_build_object(${channel}::text, ${JSON.stringify(next)}::jsonb)`,
    ...(channel === "comment"
      ? {
          ...(v.persona !== undefined ? { voicePersona: v.persona } : {}),
          ...(v.houseStyle !== undefined
            ? { voiceHouseStyle: v.houseStyle }
            : {}),
          ...(v.learnedFrom !== undefined
            ? { voiceLearnedFrom: v.learnedFrom }
            : {}),
          ...(v.card !== undefined ? { voiceCard: v.card } : {}),
        }
      : {}),
    updatedAt: Date.now(),
  });
}
