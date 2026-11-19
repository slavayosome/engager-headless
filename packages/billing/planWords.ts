import { formatMoney } from "@engager/common/money";
import type { PlanCard, PlanCheck } from "./planCheck";

/**
 * The plan card's words (US-ONA-07) — pure, SDK-free, no database and no
 * `apps/*` anything, so the dashboard and the web render the identical
 * chip, sentence and button from the identical `planCheck` answer and add
 * no words of their own (US-ONC-08, US-ONH-06). Copy is the design board's
 * exact copy (W.7, 4.1/W.3); every amount, date and trial length in it
 * comes from the read, never from a literal here.
 */

/** "Oct 28, 2026", or with a time when the copy says "[date, time]".
 * Formatted in UTC; surfaces that render in the reader's own zone pass a
 * `timeZone` from their LocalDate-style component. */
export function formatPlanDate(
  ts: number,
  opts: { time?: boolean; timeZone?: string } = {},
): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(opts.time ? { hour: "numeric", minute: "2-digit" } : {}),
    timeZone: opts.timeZone ?? "UTC",
  }).format(new Date(ts));
}

/** How a surface prints a plan date: the words module hands it the
 * timestamp and whether the copy wants a time ("[date, time]"). */
export type PlanDateFormatter = (ts: number, opts?: { time?: boolean }) => string;

function priceLine(check: PlanCheck): string | null {
  return check.price
    ? `${formatMoney(check.price.amount, check.price.currency)} every ${check.price.interval}`
    : null;
}

export type PlanCardTone =
  | "info"
  | "success"
  | "danger"
  | "warning"
  | "muted"
  | "neutral";

export type PlanCardAction =
  | { kind: "update_payment_method"; label: string }
  | { kind: "subscribe"; label: string }
  | { kind: "start_trial"; label: string };

export type PlanCardWords = {
  chip: string;
  tone: PlanCardTone;
  sentence: string;
  action: PlanCardAction;
};

/** The six cards of W.7: trial, active, payment failed, paused, cancelled
 * (an ended plan reads as the same card, "Ended on…"), and no plan yet.
 * `dateOf` prints each date: a surface that renders in the owner's own zone
 * passes its formatter, everything else gets UTC. */
export function planCardWords(
  check: PlanCheck,
  dateOf: PlanDateFormatter = formatPlanDate,
): PlanCardWords {
  const update: PlanCardAction = {
    kind: "update_payment_method",
    label: "Update payment method",
  };
  const line = priceLine(check);
  const subscribe: PlanCardAction = {
    kind: "subscribe",
    label: line ? `Subscribe — ${line}` : "Subscribe",
  };
  switch (check.plan.state) {
    case "trialing": {
      const daysLeft = check.trial.daysLeft ?? 1;
      return {
        chip: `Trial · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
        tone: "info",
        sentence:
          check.nextCharge != null
            ? `First charge, ${formatMoney(check.nextCharge.amount, check.nextCharge.currency)}, on ${dateOf(check.nextCharge.at)}. Cancel before then and pay nothing.`
            : "Cancel before the trial ends and pay nothing.",
        action: update,
      };
    }
    case "active":
      return {
        chip: "Active",
        tone: "success",
        sentence:
          line != null && check.nextCharge != null
            ? `${line}. Renews on ${dateOf(check.nextCharge.at)} for ${formatMoney(check.nextCharge.amount, check.nextCharge.currency)}.`
            : "Active.",
        action: update,
      };
    case "past_due": {
      const failed = check.failedCharge;
      const by = failed?.graceEndsAt ?? check.paidThrough;
      return {
        chip: "Payment failed",
        tone: "warning",
        sentence:
          failed != null && by != null
            ? `We couldn't take your ${formatMoney(failed.amount, failed.currency)} payment on ${dateOf(failed.at)}. Update your card by ${dateOf(by, { time: true })} to keep Engager running; after 24 hours access pauses.`
            : "We couldn't take your payment. Update your card to keep Engager running; after 24 hours access pauses.",
        action: update,
      };
    }
    case "paused": {
      const failed = check.failedCharge;
      const pausedOn = failed?.graceEndsAt ?? failed?.at ?? check.paidThrough;
      return {
        chip: "Paused",
        tone: "danger",
        sentence:
          failed != null && pausedOn != null
            ? `Access paused on ${dateOf(pausedOn)}: the ${formatMoney(failed.amount, failed.currency)} payment still hasn't gone through. Nothing runs or sends until it does. Your data stays on your Mac.`
            : "Access paused: a payment still hasn't gone through. Nothing runs or sends until it does. Your data stays on your Mac.",
        action: update,
      };
    }
    case "cancelled":
      return {
        chip: "Cancelled",
        tone: "muted",
        sentence:
          check.paidThrough != null
            ? `Works until ${dateOf(check.paidThrough)}, then stops. Subscribe again any time; the trial was once per account.`
            : "Subscribe again any time; the trial was once per account.",
        action: subscribe,
      };
    case "expired":
      return {
        chip: "Cancelled",
        tone: "muted",
        sentence:
          check.paidThrough != null
            ? `Ended on ${dateOf(check.paidThrough)}. Subscribe again any time; the trial was once per account.`
            : "Ended. Subscribe again any time; the trial was once per account.",
        action: subscribe,
      };
    case "none":
      if (check.trial.eligible && check.trial.days != null) {
        return {
          chip: "No plan yet",
          tone: "neutral",
          sentence:
            line != null
              ? `${check.trial.days} days free, then ${line} for one Mac. Card today, no charge until the trial ends.`
              : `${check.trial.days} days free for one Mac. Card today, no charge until the trial ends.`,
          action: { kind: "start_trial", label: "Start your free trial" },
        };
      }
      return {
        chip: "No plan yet",
        tone: "neutral",
        sentence: line != null ? `${line} for one Mac.` : "No plan yet.",
        action: subscribe,
      };
  }
}

export type TrialOfferWords = {
  heading: string;
  line: string;
  rows: readonly { label: string; value: string }[];
  button: string;
  note: string;
};

/**
 * The 4.1 / W.3 trial offer. The two surfaces differ only in the last
 * note. Returns null when this account is ineligible for a trial (the surfaces then
 * render the plain Subscribe words from `planCardWords`) or when the read
 * carries no Stripe price to name. `now` is injectable for tests; the
 * trial-end row is today + the configured trial length.
 */
export function trialOfferWords(
  check: PlanCheck,
  surface: "app" | "web",
  now: number = Date.now(),
): TrialOfferWords | null {
  const price = check.price;
  const days = check.trial.days;
  if (!check.trial.eligible || days == null || price == null) return null;
  const amount = formatMoney(price.amount, price.currency);
  const endsAt = now + days * 86_400_000;
  return {
    heading: `Start your ${days}-day free trial`,
    line: `Then ${amount} every ${price.interval} · One Mac · Cancel anytime`,
    rows: [
      {
        label: "Today",
        value: `${formatMoney(0, price.currency)}. Checkout takes your card.`,
      },
      {
        label: `${formatPlanDate(endsAt)}, trial ends`,
        value: `${amount}, then every ${price.interval}.`,
      },
      { label: "Before then", value: "Cancel and pay nothing." },
    ],
    button: "Start free trial",
    note:
      surface === "app"
        ? "Checkout opens in a secure Stripe window. We email you before the trial ends."
        : "Checkout opens on Stripe's secure page. We email you before the trial ends. Engager runs on a Mac with macOS 15 or later.",
  };
}

export type PausedAccessWords = {
  heading: string;
  line: string;
  /** The failed-charge row. Null when the failed invoice could not be read:
   * the row then states nothing, rather than borrow the offer price. */
  failure: string | null;
  /** What a pause leaves alone. */
  stays: string;
  button: string;
  note: string;
};

/**
 * The 4.8 "Access paused" screen. `dateOf` formats the failed charge's date;
 * the app passes its owner-zone formatter, everything else gets UTC.
 */
export function pausedAccessWords(
  check: PlanCheck,
  dateOf: (ts: number) => string = formatPlanDate,
): PausedAccessWords {
  const failed = check.failedCharge;
  return {
    heading: "Access paused",
    line: "Update your payment method to turn Engager back on.",
    failure:
      failed != null
        ? `We couldn't take your ${formatMoney(failed.amount, failed.currency)} payment on ${dateOf(failed.at)}, and the 24 hours to fix it have passed.`
        : null,
    stays:
      "While access is paused nothing runs in the background and nothing is sent. Your campaigns, drafts and Brain stay on this Mac.",
    button: "Update payment method",
    note: "Opens Stripe's billing page. Engager turns back on as soon as the payment goes through.",
  };
}

const CARD_BRANDS: Record<string, string> = {
  amex: "American Express",
  cartes_bancaires: "Cartes Bancaires",
  diners: "Diners Club",
  discover: "Discover",
  jcb: "JCB",
  mastercard: "Mastercard",
  unionpay: "UnionPay",
  visa: "Visa",
};

/**
 * "[Card] ending [1234] · expires [MM/YY]" for the default card, or null
 * when the read names no card to describe. A brand Stripe adds later reads
 * as its own id, capitalised, rather than as a guess.
 */
export function planCardLine(card: PlanCard | null): string | null {
  if (card?.last4 == null) return null;
  const brand = card.brand == null
    ? "Card"
    : (CARD_BRANDS[card.brand] ??
        card.brand.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()));
  const expires =
    card.expMonth != null && card.expYear != null
      ? ` · expires ${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`
      : "";
  return `${brand} ending ${card.last4}${expires}`;
}
