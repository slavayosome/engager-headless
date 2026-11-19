import type {
  ConversationClosedReason,
  ConversationOpsStatus,
  ConversationRelationship,
} from "@engager/database/schema";
import type { ModeKey } from "../strategy/catalog";
import type { CampaignAgentStrategy } from "../strategy/contract";

/**
 * Spec §10's eligibility table (R05) and §11's ordering and reversal rules, as
 * one pure function: an event, the conversation it lands on and the campaign's
 * policy in; the table row it falls under, a `true | false | unknown` outcome
 * and the decision drawn from it out. `unknown` is review — a person decides
 * and nothing external happens.
 *
 * Decides; never acts. What the conversation's columns take from the decision is
 * returned as `effects`, and each kind of column has its own kind of evidence
 * (INV-30): a model's reading moves the operational status and, only through
 * words it quoted verbatim, the interest fact or the closure; the relationship
 * moves only on a server read.
 */

export type EligibilityPolicy = NonNullable<CampaignAgentStrategy["eligibility"]>;
export type DmPolicy = NonNullable<CampaignAgentStrategy["dm"]>;

/** A campaign that has not configured its conversation group: a neutral reply
 *  waits for a person rather than counting as an opening. Every other key is
 *  the contract's own literal or the spec's template value. */
export const DEFAULT_ELIGIBILITY: EligibilityPolicy = {
  neutral_relevant: "review",
  negative: "skip",
  spam: "skip",
  unknown: "review",
  exclusion_set_id: null,
};

/** No DM follows an acceptance or an incoming invitation until a campaign
 *  turns one on. */
export const DEFAULT_DM_POLICY: DmPolicy = {
  outgoing_acceptance: "wait_for_interest",
  incoming_linked_opener: false,
};

/** The rows of R05, in the spec's order. */
export const R05_ROWS = [
  "room_member",
  "lead_served",
  "relevant_reply",
  "negative_reply",
  "spam_or_unrelated",
  "already_connected",
  "invitation_pending",
  "invitation_accepted",
  "incoming_invitation",
  "inbound_dm",
  "restriction_or_warning",
] as const;
export type R05Row = (typeof R05_ROWS)[number];

export type Tri = true | false | "unknown";

/**
 * - `eligible` — the configured actions may follow (their modes still apply).
 * - `review` — `unknown`: a person decides; nothing external happens.
 * - `source_skipped` — this source earns nothing; the person's conversation stays
 *   open.
 * - `paused` — pursuit stops until the person (or the owner) reopens it.
 * - `wait` — nothing to do until the person acts.
 * - `closed` — the person is suppressed, durably.
 */
export const ELIGIBILITY_DECISIONS = [
  "eligible",
  "review",
  "source_skipped",
  "paused",
  "wait",
  "closed",
] as const;
export type EligibilityDecision = (typeof ELIGIBILITY_DECISIONS)[number];

export type ReasonCode =
  | "audience_fit"
  | "positive"
  | "neutral_relevant"
  | "negative"
  | "spam"
  | "unrelated"
  | "opt_out"
  | "manual_exclude"
  | "busy"
  | "interest"
  | "interest_on_record"
  | "no_interest"
  | "unclassified"
  | "uncertain"
  | "unquoted_opt_out"
  | "unquoted_interest"
  | "already_connected"
  | "invitation_pending"
  | "invitation_sent"
  | "relationship_unverified"
  | "link_unverified"
  | "link_absent"
  | "contextual_opener"
  | "recipient_warning"
  | "account_restriction"
  | "excluded"
  | "conversation_closed"
  | "human_owned"
  | "blocked"
  | "delivery_uncertain"
  | "outcome_evidence"
  | "older_than_current";

/** What a review opened by a read that could not tell may also carry: the
 *  relationship's own facts, which open nothing. */
const RELATIONSHIP_FACTS: ReadonlySet<ReasonCode> = new Set([
  "already_connected",
  "invitation_pending",
  "invitation_sent",
]);

/**
 * Whether a review was opened by a read of the person that could not tell,
 * and by nothing else — a neutral reply, a link nobody verified, a message
 * the model was unsure of each keep it open for a person. Only a read that
 * CAN tell answers the one that could not (`relationship_observed`).
 */
export function openedByUnreadRelationship(reasons: readonly ReasonCode[]): boolean {
  return (
    reasons.includes("relationship_unverified") &&
    reasons.every((reason) => reason === "relationship_unverified" || RELATIONSHIP_FACTS.has(reason))
  );
}

/** The actions an event can rule out whatever their mode — R05's "never". */
export type ForbiddableAction = Exclude<ModeKey, "publish_comment">;
const PURSUIT: readonly ForbiddableAction[] = ["invite", "dm", "followup"];
const EVERY_ACTION: readonly ForbiddableAction[] = [
  "room_reply",
  "public_reply",
  "like_target",
  "invite",
  "accept_invite",
  "dm",
  "followup",
];

/**
 * What a classification read in a reply or a message, with every claim that
 * changes a fact already checked against the words: `optOut` and `interest`
 * are true only when the model quoted the words that say so, verbatim. A
 * claim it could not quote is named in `unquoted` instead.
 */
export type ReplyReading = {
  relevance: "relevant" | "unrelated" | "spam";
  stance: "positive" | "neutral" | "negative";
  optOut: boolean;
  busy: boolean;
  question: boolean;
  interest: boolean;
  uncertain: boolean;
  unquoted: ReadonlyArray<"opt_out" | "interest">;
};

export type EligibilityEvent =
  | { type: "room_member_spotted"; occurredAt: number }
  | { type: "lead_served"; occurredAt: number }
  | {
      type: "reply_observed" | "reply_edited" | "inbound_message_observed";
      occurredAt: number;
      /** Null when nothing classified it — a failed or not-yet-run model call. */
      reading: ReplyReading | null;
    }
  | {
      type: "relationship_observed";
      occurredAt: number;
      /** What a read of the person's profile in this account's session
       *  showed; `unknown` when it could not tell. */
      relationship: ConversationRelationship;
    }
  | {
      type: "invitation_confirmed";
      occurredAt: number;
      /** A read of the person, in the session that sent it, shows the
       *  invitation pending. Without one — the owner's own word settled the
       *  send — the invitation is on the log and the relationship stays as
       *  the last read left it. */
      relationshipRead: boolean;
    }
  | {
      type: "invitation_withdrawn";
      occurredAt: number;
      /** A read of the person, in the session that withdrew it, shows
       *  nothing pending. Without one — the owner's own word settled it —
       *  the withdrawal is on the log and the relationship stays as the last
       *  read left it. */
      relationshipRead: boolean;
    }
  | {
      type: "invitation_gone";
      occurredAt: number;
    }
  | {
      type: "invitation_accepted";
      occurredAt: number;
      /** A relationship read in this account's session shows the person
       *  connected. A notification is not one. */
      relationshipRead: boolean;
      /** Whose invitation was accepted: ours, by them (`outgoing`, the
       *  default), or theirs, by us (`incoming`). */
      direction?: "outgoing" | "incoming";
    }
  | {
      type: "incoming_invitation_observed";
      occurredAt: number;
      /** Whether the invitation is verifiably tied to an exchange under one of
       *  our comments. Timing or a name is `unknown`, never `true`. */
      linkVerified: Tri;
    }
  | {
      /** A conversion the owner attested or a receipt they reviewed shows:
       *  R08's BookingVerified, ActivationVerified or PaymentVerified. */
      type: "booking_verified" | "activation_verified" | "payment_verified";
      occurredAt: number;
    }
  | { type: "warning"; occurredAt: number; scope: "recipient" | "account" }
  | { type: "opt_out" | "manual_exclude"; occurredAt: number };

export type ConversationState = {
  relationship: ConversationRelationship;
  /** When the read that showed `relationship` was made. */
  relationshipCheckedAt: number | null;
  opsStatus: ConversationOpsStatus;
  /** When what set `opsStatus` happened. */
  opsStatusAt: number | null;
  closedReason: ConversationClosedReason | null;
  hasInterest: boolean;
  /** An invitation of ours to the person was confirmed sent — R05's
   *  "previously sent", which no later read of the page undoes. */
  invited: boolean;
  /** The reasons of the decision that sent the conversation to review, while it
   *  is `awaiting_review`. Absent where they are not known, which lifts
   *  nothing (`openedByUnreadRelationship`). */
  reviewReasons?: readonly ReasonCode[];
};

export type EligibilityInput = {
  event: EligibilityEvent;
  conversation: ConversationState;
  policy: { eligibility: EligibilityPolicy; dm: DmPolicy };
  /** The person is on the account's do-not-engage list. */
  excluded: boolean;
};

export type EligibilityEffects = {
  opsStatus?: Extract<
    ConversationOpsStatus,
    "runnable" | "awaiting_review" | "paused" | "blocked"
  >;
  close?: ConversationClosedReason;
  /** This event's quoted words are the interest evidence. */
  interest?: true;
  /** What a server read showed — never `unknown`, which moves nothing. */
  relationship?: Exclude<ConversationRelationship, "unknown">;
};

export type Eligibility = {
  /** The R05 rows the event falls under, the deciding one first. Empty when
   *  no row can be told — `unknown` — or none applies, as to a read showing
   *  two people neither connected nor invited. */
  rows: R05Row[];
  eligible: Tri;
  decision: EligibilityDecision;
  reasons: ReasonCode[];
  forbidden: ForbiddableAction[];
  effects: EligibilityEffects;
};

/** States only an explicit act clears: the owner's release, a
 *  reconciliation. No event moves a conversation out of them. */
const STICKY: ReadonlySet<ConversationOpsStatus> = new Set([
  "human_owned",
  "blocked",
  "uncertain",
]);
const STICKY_REASON: Record<"human_owned" | "blocked" | "uncertain", ReasonCode> = {
  human_owned: "human_owned",
  blocked: "blocked",
  uncertain: "delivery_uncertain",
};

type Draft = {
  rows: R05Row[];
  decision: EligibilityDecision;
  reasons: ReasonCode[];
  forbidden: ForbiddableAction[];
  effects: EligibilityEffects;
};

export function evaluateEligibility(input: EligibilityInput): Eligibility {
  const { event, conversation } = input;
  const base = decide(input);

  // A read older than the one the conversation holds arrives late: it never
  // overwrites what a newer read showed.
  if (
    base.effects.relationship !== undefined &&
    conversation.relationshipCheckedAt !== null &&
    event.occurredAt < conversation.relationshipCheckedAt
  ) {
    delete base.effects.relationship;
    base.reasons.push("older_than_current");
  }

  // A relationship the server read is a fact whatever else holds — the one
  // this event read, else the conversation's — and an invitation is never sent to
  // someone already connected, already asked, or asked before: a page that
  // offers Connect again does not make a second invitation the first.
  const relationship = base.effects.relationship ?? conversation.relationship;
  const pending = relationship === "outgoing_pending" || relationship === "incoming_pending";
  if (relationship === "connected") {
    base.rows.push("already_connected");
    base.reasons.push("already_connected");
    base.forbidden.push("invite");
  } else if (pending || conversation.invited) {
    base.rows.push("invitation_pending");
    base.reasons.push(pending ? "invitation_pending" : "invitation_sent");
    base.forbidden.push("invite");
  }

  const closing = base.effects.close !== undefined;
  if (conversation.closedReason !== null && !closing) {
    // Closed stays closed: no later message, however warm, reopens it.
    return finish({
      ...base,
      decision: "closed",
      reasons: [...base.reasons, "conversation_closed"],
      forbidden: [...EVERY_ACTION],
      effects: pick(base.effects, ["relationship"]),
    });
  }
  if (input.excluded && !closing) {
    return finish({
      ...base,
      decision: "closed",
      reasons: [...base.reasons, "excluded"],
      forbidden: [...EVERY_ACTION],
      effects: pick(base.effects, ["relationship"]),
    });
  }

  let { decision } = base;
  const reasons = [...base.reasons];
  const effects = { ...base.effects };
  if (STICKY.has(conversation.opsStatus)) {
    // The owner holds the conversation, or a send is unsettled: an event is
    // recorded and its facts kept, but it moves no status and opens nothing.
    delete effects.opsStatus;
    reasons.push(STICKY_REASON[conversation.opsStatus as keyof typeof STICKY_REASON]);
    if (decision === "eligible") decision = "review";
  } else if (
    conversation.opsStatusAt !== null &&
    event.occurredAt < conversation.opsStatusAt &&
    effects.opsStatus !== undefined
  ) {
    // An older event arriving late never overwrites what a newer one set.
    delete effects.opsStatus;
    reasons.push("older_than_current");
    if (decision === "eligible") decision = "review";
  }
  return finish({ ...base, decision, reasons, effects });
}

function finish(draft: Draft): Eligibility {
  return {
    rows: [...new Set(draft.rows)],
    eligible:
      draft.decision === "eligible" ? true : draft.decision === "review" ? "unknown" : false,
    decision: draft.decision,
    reasons: [...new Set(draft.reasons)],
    forbidden: EVERY_ACTION.filter((action) => draft.forbidden.includes(action)),
    effects: draft.effects,
  };
}

function pick(effects: EligibilityEffects, keys: (keyof EligibilityEffects)[]): EligibilityEffects {
  return Object.fromEntries(
    keys.flatMap((key) => (effects[key] !== undefined ? [[key, effects[key]]] : [])),
  ) as EligibilityEffects;
}

function review(rows: R05Row[], reasons: ReasonCode[], extra: Partial<Draft> = {}): Draft {
  return {
    rows,
    decision: "review",
    reasons,
    forbidden: [],
    effects: { opsStatus: "awaiting_review" },
    ...extra,
  };
}

/** The decision the event earns on its own, before the conversation's standing
 *  — closed, excluded, held, or newer — has its say. */
function decide({ event, conversation, policy }: EligibilityInput): Draft {
  switch (event.type) {
    case "room_member_spotted":
      return { rows: ["room_member"], decision: "eligible", reasons: ["audience_fit"],
        forbidden: EVERY_ACTION.filter((action) => action !== "room_reply"), effects: {} };
    case "lead_served":
      // Scout found a buyer by their own words: their post, their comment or an
      // invitation may follow, each by its own step's mode. They have said
      // nothing to us, so there is nothing yet to answer, no conversation to
      // continue and no invitation of theirs to accept.
      return { rows: ["lead_served"], decision: "eligible", reasons: ["audience_fit"],
        forbidden: ["public_reply", "accept_invite", "dm", "followup"], effects: {} };
    case "reply_observed":
    case "reply_edited":
      return decideReply(event.reading, policy.eligibility);
    case "inbound_message_observed":
      return decideMessage(event.reading, conversation.hasInterest);
    case "relationship_observed":
      // A read the page could not answer is a person's to settle; it is
      // never "not connected". One it could answer is a fact, and opens
      // nothing by itself: every action still waits on its own trigger. It
      // does answer the review a read that could not tell opened, and no
      // other: that one needs no person once the page can say.
      return event.relationship === "unknown"
        ? review([], ["relationship_unverified"])
        : {
            rows: [],
            decision: "wait",
            reasons: [],
            forbidden: [],
            effects: {
              relationship: event.relationship,
              ...(conversation.opsStatus === "awaiting_review" &&
              openedByUnreadRelationship(conversation.reviewReasons ?? [])
                ? { opsStatus: "runnable" as const }
                : {}),
            },
          };
    case "invitation_confirmed":
      // R08's InvitationConfirmed: a wait on their answer. It forbids a second
      // invitation whatever a later page offers (`invited`), and moves the
      // relationship only where the read that confirmed it showed it pending.
      return {
        rows: ["invitation_pending"],
        decision: "wait",
        reasons: ["invitation_sent"],
        forbidden: ["invite"],
        effects: event.relationshipRead ? { relationship: "outgoing_pending" } : {},
      };
    case "invitation_withdrawn":
      // The owner took our invitation back: nothing waits on their answer
      // any more. It opens nothing, still forbids a second invitation, and
      // moves the relationship only where the read that confirmed it showed
      // nothing pending.
      return {
        rows: [],
        decision: "wait",
        reasons: [],
        forbidden: ["invite"],
        effects: event.relationshipRead ? { relationship: "not_connected" } : {},
      };
    case "invitation_gone":
      // LinkedIn no longer lists our invitation: nothing waits on their
      // answer any more. It opens nothing and still forbids a second
      // invitation; the read that found it gone already moved the
      // relationship.
      return { rows: [], decision: "wait", reasons: [], forbidden: ["invite"], effects: {} };
    case "invitation_accepted": {
      // Ours accepted is R05's "outgoing invitation accepted"; theirs, by us,
      // its "incoming invitation with verified comment link" — whose one
      // contextual opener is a decision of its own, never a DM of this event.
      const row = event.direction === "incoming" ? "incoming_invitation" : "invitation_accepted";
      if (!event.relationshipRead) {
        return review([row], ["relationship_unverified"]);
      }
      const opener =
        event.direction === "incoming"
          ? policy.dm.incoming_linked_opener
          : policy.dm.outgoing_acceptance === "contextual_opener";
      return conversation.hasInterest || opener
        ? {
            rows: [row],
            decision: "eligible",
            reasons: [conversation.hasInterest ? "interest" : "contextual_opener"],
            // Their invitation earns one opener, never a chase: a follow-up
            // waits on their answer (R06).
            forbidden: event.direction === "incoming" && !conversation.hasInterest ? ["followup"] : [],
            effects: { relationship: "connected", opsStatus: "runnable" },
          }
        : {
            // Accepting an invitation is not interest: no sales DM follows it.
            rows: [row],
            decision: "wait",
            reasons: ["no_interest"],
            forbidden: ["dm", "followup"],
            effects: { relationship: "connected" },
          };
    }
    case "incoming_invitation_observed": {
      const relationship = { relationship: "incoming_pending" } as const;
      if (event.linkVerified !== true) {
        return review(
          ["incoming_invitation"],
          [event.linkVerified === false ? "link_absent" : "link_unverified"],
          { effects: { ...relationship, opsStatus: "awaiting_review" } },
        );
      }
      return {
        rows: ["incoming_invitation"],
        decision: "eligible",
        reasons: policy.dm.incoming_linked_opener ? ["contextual_opener"] : [],
        forbidden: policy.dm.incoming_linked_opener ? ["followup"] : ["dm", "followup"],
        effects: { ...relationship, opsStatus: "runnable" },
      };
    }
    case "booking_verified":
    case "activation_verified":
    case "payment_verified":
      // Verified evidence of a conversion is what a Check outcome step enters
      // on. It opens no contact and moves no column: the conversation's outcome
      // columns are the outcome rows' own projection.
      return { rows: [], decision: "eligible", reasons: ["outcome_evidence"], forbidden: [], effects: {} };
    case "warning":
      return event.scope === "recipient"
        ? {
            rows: ["restriction_or_warning"],
            decision: "paused",
            reasons: ["recipient_warning"],
            forbidden: [...EVERY_ACTION],
            effects: { opsStatus: "blocked" },
          }
        : {
            // The account's own pause is the account's (Phase 47); here it
            // only stops this person's work.
            rows: ["restriction_or_warning"],
            decision: "paused",
            reasons: ["account_restriction"],
            forbidden: [...EVERY_ACTION],
            effects: {},
          };
    case "opt_out":
    case "manual_exclude":
      return {
        rows: event.type === "opt_out" ? ["negative_reply"] : [],
        decision: "closed",
        reasons: [event.type],
        forbidden: [...EVERY_ACTION],
        effects: { close: event.type },
      };
  }
}

/** The reading's verdict on its own trust: whether it can be acted on, or a
 *  person has to look first. */
function unreadable(reading: ReplyReading | null): ReasonCode | null {
  if (!reading) return "unclassified";
  // A model that says "opt-out" but cannot quote it may still be right, and
  // missing a refusal is the costly mistake: a person looks.
  if (reading.unquoted.includes("opt_out")) return "unquoted_opt_out";
  if (reading.uncertain) return "uncertain";
  return null;
}

function optOut(rows: R05Row[]): Draft {
  return {
    rows,
    decision: "closed",
    reasons: ["opt_out"],
    forbidden: [...EVERY_ACTION],
    effects: { close: "opt_out" },
  };
}

/** Interest is a fact only where its words were quoted, and an opt-out in the
 *  same message outranks it. */
function interestOf(reading: ReplyReading): Pick<EligibilityEffects, "interest"> {
  return reading.interest && !reading.optOut ? { interest: true } : {};
}

function decideReply(reading: ReplyReading | null, policy: EligibilityPolicy): Draft {
  const doubt = unreadable(reading);
  if (doubt || !reading) return review([], [doubt ?? "unclassified"]);
  if (reading.optOut) return optOut(["negative_reply"]);
  const quoted = reading.unquoted.includes("interest") ? (["unquoted_interest"] as const) : [];
  if (reading.relevance !== "relevant") {
    return {
      rows: ["spam_or_unrelated"],
      decision: "source_skipped",
      reasons: [reading.relevance === "spam" ? "spam" : "unrelated", ...quoted],
      forbidden: [...EVERY_ACTION],
      effects: {},
    };
  }
  // "Busy this week" moves nothing here: it is not an opt-out, and when to
  // pick the conversation up is the step's to read in their words and decide
  // (a wait it names, `agentStep/wait.ts`). Below, the reply earns what its
  // stance earns, and the label stays on the event for the step and the owner.
  if (reading.stance === "negative") {
    const reasons: ReasonCode[] = ["negative", ...quoted];
    return policy.negative === "review"
      ? review(["negative_reply"], reasons, { forbidden: [...PURSUIT] })
      : {
          rows: ["negative_reply"],
          decision: "source_skipped",
          reasons,
          forbidden: [...PURSUIT],
          effects: {},
        };
  }
  const reasons: ReasonCode[] = [
    reading.stance === "positive" ? "positive" : "neutral_relevant",
    ...(reading.interest ? (["interest"] as const) : []),
    ...quoted,
  ];
  // Relevance is not interest: a neutral reply earns what the campaign says a
  // neutral reply earns, never less for not being enthusiastic.
  const verdict =
    reading.stance === "positive" ? "eligible" : policy.neutral_relevant;
  if (verdict === "review") {
    return review(["relevant_reply"], reasons, {
      effects: { opsStatus: "awaiting_review", ...interestOf(reading) },
    });
  }
  if (verdict === "skip") {
    return {
      rows: ["relevant_reply"],
      decision: "source_skipped",
      reasons,
      forbidden: [],
      effects: interestOf(reading),
    };
  }
  return {
    rows: ["relevant_reply"],
    decision: "eligible",
    reasons,
    forbidden: [],
    effects: { opsStatus: "runnable", ...interestOf(reading) },
  };
}

/** R05's inbound-DM row: what the message actually intends. A greeting, a
 *  courtesy or an unrelated question is not product interest. Once their
 *  interest stands on the conversation, every message of theirs is the step's to
 *  read — "busy, next week", a question, a thank-you — and whether to answer,
 *  and when, is its decision; before it, a message that shows none earns
 *  nothing, since a DM answers someone who asked (R05/R06). "Busy" is a label
 *  on the event, never a pause. */
function decideMessage(reading: ReplyReading | null, interestStands: boolean): Draft {
  const doubt = unreadable(reading);
  if (doubt || !reading) return review(["inbound_dm"], [doubt ?? "unclassified"]);
  if (reading.optOut) return optOut(["inbound_dm", "negative_reply"]);
  if (reading.relevance === "spam") {
    return {
      rows: ["inbound_dm"],
      decision: "source_skipped",
      reasons: ["spam"],
      forbidden: [...EVERY_ACTION],
      effects: {},
    };
  }
  const busy = reading.busy ? (["busy"] as const) : [];
  if (reading.interest || interestStands) {
    return {
      rows: ["inbound_dm"],
      decision: "eligible",
      reasons: [reading.interest ? "interest" : "interest_on_record", ...busy],
      forbidden: [],
      effects: { opsStatus: "runnable", ...interestOf(reading) },
    };
  }
  return {
    rows: ["inbound_dm"],
    decision: "wait",
    reasons: [
      "no_interest",
      ...busy,
      ...(reading.unquoted.includes("interest") ? (["unquoted_interest"] as const) : []),
    ],
    // A follow-up chases interest, and there is none to chase.
    forbidden: ["followup"],
    effects: {},
  };
}
