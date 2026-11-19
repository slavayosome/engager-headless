import { ACTION_MODES, CAPABILITIES, modeKeyOf, type ActionMode, type CapabilityId } from "./catalog";

/**
 * EVERY STORED VERSION, READ AS TODAY'S SCHEMA. Versions are appended and
 * never rewritten (`campaign_strategies`), so a document written under an
 * older schema stays exactly as it was written — history, the version an undo
 * restores, one still waiting for its instant — and is upgraded each time it
 * is read, before the contract validates it (`parseStrategy`). Pure.
 *
 *   2 → 3   ONE MODE PER ACTION, ON ITS STEP (founder, 2026-10-16). Version 2
 *           kept a second mode per send on the document, `modes.<key>`, beside
 *           the one on each step's binding, so a step could show one mode
 *           while the campaign's held it to another. Each binding now takes
 *           the STRICTER of the two — Off, then Ask me, then Automatic — and
 *           `modes` goes: nothing widens by itself, and an action the campaign
 *           held at Ask me says Ask me on its step. A binding with no mode of
 *           its own takes the campaign's; one whose action the campaign set
 *           nothing for keeps its own. The account default's `modes` were
 *           never written to (`accountPolicy.ts` is its one writer), so they
 *           go with nothing to fold.
 *   4 → 5   A binding may carry `intent_ceilings`, the most an opener may be
 *           to a lead by what their words show. No version 4 binding has any,
 *           which reads each intent's default, so only the stamp moves.
 *   5 → 6   A campaign has no run mode: every campaign is live, and a send is
 *           held only by its action's mode. `run_mode` goes. A campaign whose
 *           document said `shadow` was paused when its column dropped
 *           (migration 0329), and a restore pauses it too, so nothing goes
 *           live by inference.
 *
 * Nothing is written when a document is read. The first agent start after an
 * upgrade projects each version in force onto its worker rows as it now reads
 * (`operations/reprojectStrategies.ts`); a stored document becomes today's schema
 * when the owner next changes it, and not before.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isActionMode = (value: unknown): value is ActionMode =>
  typeof value === "string" && (ACTION_MODES as readonly string[]).includes(value);

/** The stricter of two send modes: Off, then Ask me, then Automatic. */
export function stricterMode(a: ActionMode, b: ActionMode): ActionMode {
  return ACTION_MODES.indexOf(a) <= ACTION_MODES.indexOf(b) ? a : b;
}

/** Each schema version a stored document can be in, and what reads it as the
 *  next one. */
const UPGRADES: Readonly<Record<number, (document: Record<string, unknown>) => Record<string, unknown>>> = {
  2: toVersion3,
  3: toVersion4,
  4: toVersion5,
  5: toVersion6,
};

/**
 * A stored document as the current schema — or `input` itself when it is
 * current, or is nothing this can read, and the contract says why.
 */
export function upgradeStrategy(input: unknown): unknown {
  let document = input;
  while (isRecord(document) && typeof document.schema_version === "number") {
    const upgrade = UPGRADES[document.schema_version];
    if (!upgrade) break;
    document = upgrade(document);
  }
  return document;
}

/** A stored version's document as the current schema — what a diff against
 *  it, or a copy of it, starts from, so neither reads the upgrade as a
 *  change of its own. */
export function currentDocument(document: Record<string, unknown>): Record<string, unknown> {
  return upgradeStrategy(document) as Record<string, unknown>;
}

function toVersion3(document: Record<string, unknown>): Record<string, unknown> {
  const { modes, ...rest } = document;
  const campaign = isRecord(modes) ? modes : {};
  return {
    ...rest,
    schema_version: 3,
    ...(Array.isArray(rest.action_bindings)
      ? { action_bindings: rest.action_bindings.map((binding) => foldCampaignMode(binding, campaign)) }
      : {}),
  };
}

// Freeze the v3 seed's complete grant set; future catalog additions must not
// change which historical defaults the owner had left unrestricted.
const VERSION_3_GRANTS = ["grant_publish_comment", "grant_public_reply", "grant_like",
  "grant_invite", "grant_accept", "grant_dm", "grant_followup"] as const;

/** Only a still-complete account default inherits the new grant. Campaigns
 * retain their steps, grants and modes; adding Meet the room still confirms. */
function toVersion4(document: Record<string, unknown>): Record<string, unknown> {
  const grants = document.grants;
  const completeDefault = document.campaign_id === null && Array.isArray(grants) &&
    VERSION_3_GRANTS.every((grant) => grants.includes(grant));
  return { ...document, schema_version: 4,
    ...(completeDefault && !grants.includes("grant_room_reply") ? { grants: [...grants, "grant_room_reply"] } : {}) };
}

/** An intent a binding leaves out reads its default, so a version 4 document
 *  is version 5 as it stands. */
function toVersion5(document: Record<string, unknown>): Record<string, unknown> {
  return { ...document, schema_version: 5 };
}

/** A campaign's `run_mode` is gone; nothing else in the document moves. */
function toVersion6(document: Record<string, unknown>): Record<string, unknown> {
  const { run_mode: _runMode, ...rest } = document;
  return { ...rest, schema_version: 6 };
}

/** One binding with the campaign's mode for its action folded in. */
function foldCampaignMode(binding: unknown, campaign: Record<string, unknown>): unknown {
  if (
    !isRecord(binding) ||
    typeof binding.capability_ref !== "string" ||
    !Object.hasOwn(CAPABILITIES, binding.capability_ref)
  ) {
    return binding;
  }
  const key = modeKeyOf(binding.capability_ref as CapabilityId);
  const held = key === null ? undefined : campaign[key];
  if (!isActionMode(held)) return binding;
  if (binding.mode === undefined) return { ...binding, mode: held };
  return isActionMode(binding.mode) ? { ...binding, mode: stricterMode(binding.mode, held) } : binding;
}
