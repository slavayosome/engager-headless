/**
 * Email templates as pure functions.
 *
 * Each returns `{ subject, html, text }`. HTML is simple inline-styled markup
 * (no external CSS, no React) so it renders consistently across mail clients;
 * `text` is the plaintext fallback. URLs render as a button in HTML and as a
 * bare link in the text fallback.
 */

import { formatMoney } from "@engager/common/money";
import { TRIAL_REMINDER_LEAD_DAYS } from "@engager/common/trial-reminder";

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const BRAND = "Engager";

export function emailOtp({ code }: { code: string }): RenderedEmail {
  if (!/^\d{6}$/.test(code)) throw new Error("Invalid email code");
  return {
    subject: "Your Engager sign-in code",
    html: layout(`<p>Enter this code in Engager to sign in:</p><p style="font-size:32px;letter-spacing:8px;font-weight:600">${code}</p><p>It expires in 10 minutes. If you did not request it, you can ignore this email.</p>`),
    text: `Your Engager sign-in code: ${code}\n\nIt expires in 10 minutes. If you did not request it, you can ignore this email.`,
  };
}

/** Minimal HTML escaping for interpolated user-controlled strings. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wraps body markup in a centered, neutral container with a footer. */
function layout(
  bodyHtml: string,
  footerText = `You received this email from ${BRAND}.`,
): string {
  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;border:1px solid #e4e4e7;padding:32px;">
            <tr>
              <td>
                <div style="font-size:18px;font-weight:600;margin-bottom:24px;color:#18181b;">${BRAND}</div>
                ${bodyHtml}
                <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e4e4e7;font-size:12px;color:#a1a1aa;">
                  ${escapeHtml(footerText)}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Renders a primary call-to-action button. */
function button(url: string, label: string): string {
  const safeUrl = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td align="center" style="border-radius:8px;background-color:#18181b;">
        <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

/** A paragraph of body copy. */
function paragraph(text: string): string {
  return `<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 16px 0;">${text}</p>`;
}

export type WelcomeEmailProps = { name?: string };

export function welcomeEmail({ name }: WelcomeEmailProps = {}): RenderedEmail {
  const greeting = name ? `Hi ${name},` : "Hi there,";
  const subject = `Welcome to ${BRAND}`;
  const html = layout(
    paragraph(escapeHtml(greeting)) +
      paragraph(
        `Welcome to ${BRAND}. You're all set — connect your account to start running campaigns whenever you're ready.`,
      ),
  );
  const text = [
    greeting,
    "",
    `Welcome to ${BRAND}. You're all set — connect your account to start running campaigns whenever you're ready.`,
    "",
    `— The ${BRAND} team`,
  ].join("\n");
  return { subject, html, text };
}

export type OrgInviteEmailProps = {
  orgName: string;
  url: string;
  inviterName?: string;
};

export function orgInviteEmail({ orgName, url, inviterName }: OrgInviteEmailProps): RenderedEmail {
  const subject = `You've been invited to ${orgName} on ${BRAND}`;
  const invitedBy = inviterName
    ? `${escapeHtml(inviterName)} invited you to join`
    : "You've been invited to join";
  const html = layout(
    paragraph(`${invitedBy} <strong>${escapeHtml(orgName)}</strong> on ${BRAND}.`) +
      button(url, "Accept invitation") +
      paragraph(`If the button doesn't work, paste this link into your browser:<br />${escapeHtml(url)}`),
  );
  const invitedByText = inviterName
    ? `${inviterName} invited you to join`
    : "You've been invited to join";
  const text = [
    `${invitedByText} ${orgName} on ${BRAND}.`,
    "",
    "Accept invitation:",
    url,
    "",
    "If you weren't expecting this, you can safely ignore this email.",
  ].join("\n");
  return { subject, html, text };
}

export type LeadHotEmailProps = {
  /** Person snapshot. */
  name?: string | null;
  headline?: string | null;
  /** Why the lead is hot ("explicit ask", "authority: ceo", …). */
  reasons?: string[] | null;
  /** Verbatim quote from their comment. */
  evidence?: string | null;
  /** Their full comment text. */
  commentText?: string | null;
  /** Suggested DM to send them — copy-paste, never auto-sent. */
  dmDraft?: string | null;
  /** Dashboard leads URL. */
  url?: string;
  orgName?: string;
};

/**
 * "You have a hot lead" — sent by the notify_lead job the moment an inbound
 * comment/reply crosses into the hot tier. One per lead, ever. The DM draft
 * (when present) is a suggestion to copy-paste — nothing on the lead path
 * sends it.
 */
export function leadHotEmail({
  name,
  headline,
  reasons,
  evidence,
  commentText,
  dmDraft,
  url,
  orgName,
}: LeadHotEmailProps): RenderedEmail {
  const who = name?.trim() || "Someone";
  const subject = `${BRAND}: hot lead — ${who} wants to hear from you`;
  const where = orgName ? ` on ${escapeHtml(orgName)}` : "";
  const quote = (evidence?.trim() || commentText?.trim() || "").slice(0, 500);
  const quoteBlock = quote
    ? `<blockquote style="margin:0 0 16px 0;padding:12px 16px;border-left:3px solid #18181b;background-color:#fafafa;font-size:14px;line-height:1.6;color:#18181b;">&ldquo;${escapeHtml(quote)}&rdquo;</blockquote>`
    : "";
  const dmBlock = dmDraft?.trim()
    ? `<div style="margin:0 0 16px 0;">
        <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;margin-bottom:8px;">Suggested DM (copy &amp; send it yourself)</div>
        <div style="padding:12px 16px;border:1px dashed #d4d4d8;border-radius:8px;font-size:14px;line-height:1.6;color:#18181b;">${escapeHtml(dmDraft.trim())}</div>
      </div>`
    : "";
  const html = layout(
    paragraph(
      `<strong>${escapeHtml(who)}</strong>${headline ? ` <span style="color:#71717a;">(${escapeHtml(headline)})</span>` : ""} just showed buying intent${where}:`,
    ) +
      quoteBlock +
      (reasons?.length
        ? paragraph(`<span style="color:#71717a;">Why it's hot: ${escapeHtml(reasons.join(" · "))}</span>`)
        : "") +
      dmBlock +
      (url ? button(url, "View lead") : "") +
      paragraph(`Leads go cold fast — a reply within a day or two keeps the door open.`),
  );
  const text = [
    `Hot lead${orgName ? ` on ${orgName}` : ""}: ${who}${headline ? ` (${headline})` : ""} just showed buying intent.`,
    "",
    ...(quote ? [`"${quote}"`, ""] : []),
    ...(reasons?.length ? [`Why it's hot: ${reasons.join(", ")}`, ""] : []),
    ...(dmDraft?.trim() ? ["Suggested DM (copy & send it yourself):", dmDraft.trim(), ""] : []),
    ...(url ? [`View lead: ${url}`, ""] : []),
    "Leads go cold fast — a reply within a day or two keeps the door open.",
  ].join("\n");
  return { subject, html, text };
}

export type LeadNudgeEmailProps = {
  leads: {
    name?: string | null;
    headline?: string | null;
    evidence?: string | null;
    dmDraft?: string | null;
  }[];
  url?: string;
  orgName?: string;
};

/**
 * "These leads are going cold" — the daily staleness digest for hot leads that
 * were emailed but never touched (status still `new` ~2 days later). One nudge
 * per lead, ever. DMs remain copy-paste suggestions.
 */
export function leadNudgeEmail({ leads, url, orgName }: LeadNudgeEmailProps): RenderedEmail {
  const n = leads.length;
  const subject = `${BRAND}: ${n} hot lead${n === 1 ? "" : "s"} going cold — reach out today`;
  const where = orgName ? ` on ${escapeHtml(orgName)}` : "";
  const items = leads
    .map((l) => {
      const who = escapeHtml(l.name?.trim() || "Someone");
      const headline = l.headline ? ` <span style="color:#71717a;">(${escapeHtml(l.headline)})</span>` : "";
      const quote = l.evidence?.trim()
        ? `<div style="margin-top:4px;font-size:13px;color:#3f3f46;font-style:italic;">&ldquo;${escapeHtml(l.evidence.trim().slice(0, 200))}&rdquo;</div>`
        : "";
      const dm = l.dmDraft?.trim()
        ? `<div style="margin-top:6px;padding:8px 12px;border:1px dashed #d4d4d8;border-radius:6px;font-size:13px;color:#18181b;">${escapeHtml(l.dmDraft.trim())}</div>`
        : "";
      return `<div style="margin:0 0 16px 0;"><strong>${who}</strong>${headline}${quote}${dm}</div>`;
    })
    .join("");
  const html = layout(
    paragraph(
      `${n === 1 ? "A hot lead" : `${n} hot leads`}${where} asked to hear from you and ${n === 1 ? "hasn't" : "haven't"} had a reply yet. A short DM today keeps the door open:`,
    ) +
      items +
      (url ? button(url, "Open leads") : ""),
  );
  const text = [
    `${n === 1 ? "A hot lead" : `${n} hot leads`}${orgName ? ` on ${orgName}` : ""} asked to hear from you and ${n === 1 ? "hasn't" : "haven't"} had a reply yet.`,
    "",
    ...leads.flatMap((l) => [
      `- ${l.name?.trim() || "Someone"}${l.headline ? ` (${l.headline})` : ""}`,
      ...(l.evidence?.trim() ? [`  "${l.evidence.trim().slice(0, 200)}"`] : []),
      ...(l.dmDraft?.trim() ? [`  Suggested DM: ${l.dmDraft.trim()}`] : []),
    ]),
    "",
    ...(url ? [`Open leads: ${url}`] : []),
  ].join("\n");
  return { subject, html, text };
}

/** Fixed operational notice. Provider IDs, private URLs and tenant output do
 * not belong in the message; the owner opens the existing status surface. */
export function runtimeAlertEmail(): RenderedEmail {
  const subject = `${BRAND}: your Cloud worker needs attention`;
  const message = "Your Cloud worker failed consecutive health checks. Scheduled work may be delayed.";
  const action = "Open Engager on your computer and go to Your agent to review its status. If it remains unavailable, contact Engager support.";
  return {
    subject,
    html: layout(paragraph(message) + paragraph(action)),
    text: `${message}\n\n${action}`,
  };
}

// --- US-ONI-04: payment-failed email (additive; keep separate for merge) ---

export type PaymentFailedEmailProps = {
  /** The failed invoice's amount due, already formatted in its own currency
   * by the caller (this package stays free of billing formatters). */
  amount: string;
  /** Epoch ms of the failed attempt; printed as a UTC date. */
  failedAt: number;
  /** Brand of the payment method that was tried, as Stripe names it. */
  cardBrand: string;
  /** Last four digits only — never more of the card number. */
  cardLast4: string;
  /** Epoch ms the grace ends (the caller adds the shared `PAYMENT_GRACE_MS`
   * to the recorded failure instant); printed in UTC with the zone named. */
  graceEndsAt: number;
  /** The grace window in whole hours, from that same `PAYMENT_GRACE_MS` — the
   * "within N hours" the copy names is never typed in here a second time. */
  graceHours: number;
  /** The cloud's stable `/account` address — never a Stripe Billing Portal
   * session URL, which is minted for one visit and would not survive the
   * whole grace period. */
  accountUrl: string;
};

/**
 * "We couldn't take your payment" (screen 8.2) — sent once per failed
 * invoice. The link is the cloud's own stable account address: signed out
 * it goes through sign-in and back, signed in it opens the Stripe portal
 * on demand, and opening it twice changes nothing.
 */
export function paymentFailedEmail({
  amount,
  failedAt,
  cardBrand,
  cardLast4,
  graceEndsAt,
  graceHours,
  accountUrl,
}: PaymentFailedEmailProps): RenderedEmail {
  if (!Number.isInteger(graceHours) || graceHours < 1) {
    throw new Error("payment-failed email requires the grace window in hours");
  }
  const utcDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const utcDateTime = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  const brand = cardBrand.trim();
  const card = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : brand;
  const subject = "We couldn't take your payment";
  const within = `within ${graceHours} ${graceHours === 1 ? "hour" : "hours"}`;
  const first = `Your ${amount} payment for Engager didn't go through on ${utcDate.format(new Date(failedAt))}, on your ${card} ending ${cardLast4}.`;
  const second = `Update your payment method ${within} to keep Engager running. After ${utcDateTime.format(new Date(graceEndsAt))}, access pauses until the payment goes through. Nothing on your Mac is lost.`;
  const linkLine = `The link opens Stripe's secure billing page. If the button doesn't work, paste this link into your browser: ${accountUrl}`;
  const footer = "You received this email because a payment on your Engager plan failed.";
  const html = layout(
    `<h1 style="margin:0 0 16px 0;font-size:20px;line-height:28px;font-weight:600;color:#18181b;">We couldn't take your payment</h1>` +
      paragraph(escapeHtml(first)) +
      paragraph(
        `<strong>Update your payment method ${within}</strong> to keep Engager running. After ${escapeHtml(utcDateTime.format(new Date(graceEndsAt)))}, access pauses until the payment goes through. Nothing on your Mac is lost.`,
      ) +
      button(accountUrl, "Update payment method") +
      paragraph(escapeHtml(linkLine)),
    footer,
  );
  const text = [
    subject,
    "",
    first,
    "",
    second,
    "",
    "Update payment method:",
    accountUrl,
    "",
    linkLine,
    "",
    footer,
  ].join("\n");
  return { subject, html, text };
}

// Stripe's own `customer.subscription.trial_will_end` lead (O-1), shared by
// the receipt and the app's trial note. The reminder names the days actually
// left when delivered, including when delayed or the trial was extended.
export { TRIAL_REMINDER_LEAD_DAYS } from "@engager/common/trial-reminder";

export type TrialStartedEmailProps = {
  /** Receipt render time, epoch ms, to avoid promising a reminder already due. */
  renderedAt: number;
  /** The trial's first invoice total (minor units) and its currency. */
  chargedTodayAmount: number;
  chargedTodayCurrency: string;
  /** The subscription's `trial_end`, epoch ms. The first charge lands then. */
  trialEndsAt: number;
  /** The upcoming invoice's amount due (minor units, tax included). */
  firstChargeAmount: number;
  firstChargeCurrency: string;
  /** The Stripe Price's amount (minor units), currency and interval. */
  priceAmount: number;
  priceCurrency: string;
  priceInterval: string;
  /** The default payment method's card brand (as Stripe spells it) and last4. */
  cardBrand: string;
  cardLast4: string;
  /** The first invoice's number. Never a Stripe id. */
  receiptNumber: string;
  /** The cloud's `/account` and `/download`, absolute. */
  accountUrl: string;
  downloadUrl: string;
};

/** "Oct 28, 2026", in UTC. */
function trialDate(epochMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(epochMs));
}

const CARD_BRAND_NAMES: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  unknown: "Card",
};

/** Display name for a Stripe card brand ("visa" → "Visa"). */
function cardBrandName(brand: string): string {
  const key = brand.trim().toLowerCase();
  return CARD_BRAND_NAMES[key] ?? `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function requireTrialEmailAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("trial email amounts must be non-negative integers");
  }
}

function requireAbsoluteUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("trial email links must be absolute URLs");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("trial email links must be absolute URLs");
  }
}

/** One receipt row: a muted label, the value floated to the card's edge. */
function trialReceiptRow(label: string, value: string, last = false): string {
  const border = `border-top:1px solid #e5e5e5;${last ? "border-bottom:1px solid #e5e5e5;" : ""}`;
  return `<div style="${border}padding:10px 0;font-size:14px;line-height:20px;"><span style="color:#737373;">${label}</span><span style="float:right;color:#0a0a0a;">${value}</span></div>`;
}

/**
 * The trial-started receipt (US-ONI-02, board 8.3). Pure: every figure
 * arrives as a prop from a live Stripe read, and a blank or malformed one
 * throws rather than rendering an email with a hole in it. Table-free
 * inline-styled markup with a text mark — mail clients strip inline SVG.
 */
export function trialStartedEmail(props: TrialStartedEmailProps): RenderedEmail {
  requireTrialEmailAmount(props.chargedTodayAmount);
  requireTrialEmailAmount(props.firstChargeAmount);
  requireTrialEmailAmount(props.priceAmount);
  for (const currency of [
    props.chargedTodayCurrency,
    props.firstChargeCurrency,
    props.priceCurrency,
  ]) {
    if (!/^[a-z]{3}$/i.test(currency)) {
      throw new Error("trial email currencies must be ISO codes");
    }
  }
  if (!Number.isFinite(props.trialEndsAt) || props.trialEndsAt <= 0) {
    throw new Error("trial email requires a trial end");
  }
  if (!Number.isFinite(props.renderedAt) || props.renderedAt <= 0) {
    throw new Error("trial email requires a render time");
  }
  if (!props.priceInterval.trim()) {
    throw new Error("trial email requires a billing interval");
  }
  if (!props.cardBrand.trim() || !/^\d{4}$/.test(props.cardLast4)) {
    throw new Error("trial email requires the card on file");
  }
  if (!props.receiptNumber.trim()) {
    throw new Error("trial email requires a receipt number");
  }
  requireAbsoluteUrl(props.accountUrl);
  requireAbsoluteUrl(props.downloadUrl);

  const subject = "Your Engager trial has started";
  const endsOn = trialDate(props.trialEndsAt);
  const chargedToday = formatMoney(props.chargedTodayAmount, props.chargedTodayCurrency);
  const firstCharge = `${formatMoney(props.firstChargeAmount, props.firstChargeCurrency)} on ${endsOn}`;
  const then = `${formatMoney(props.priceAmount, props.priceCurrency)} every ${props.priceInterval.trim()}`;
  const card = `${cardBrandName(props.cardBrand)} ending ${props.cardLast4}`;
  const reminder = props.trialEndsAt - props.renderedAt > TRIAL_REMINDER_LEAD_DAYS * 86_400_000
    ? ` We'll email you ${TRIAL_REMINDER_LEAD_DAYS} days before.`
    : "";
  const cancelLine = `Cancel before ${endsOn} and you won't be charged.${reminder}`;
  const intro = "Thanks for trying Engager. Nothing was charged today. Here's your receipt.";
  const footer = "You received this email because you started an Engager trial.";
  const rows: [string, string][] = [
    ["Plan", "Engager for Mac, one Mac"],
    ["Charged today", chargedToday],
    ["Trial ends", endsOn],
    ["First charge", firstCharge],
    ["Then", then],
    ["Card", card],
    ["Receipt", props.receiptNumber.trim()],
  ];
  const body = [
    `<div style="font-size:18px;font-weight:600;margin-bottom:24px;color:#0a0a0a;">${BRAND}</div>`,
    `<h1 style="margin:0 0 16px 0;font-size:20px;line-height:28px;font-weight:600;color:#0a0a0a;">Your trial has started</h1>`,
    `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#404040;">${intro}</p>`,
    `<div>${rows.map(([label, value], i) => trialReceiptRow(escapeHtml(label), escapeHtml(value), i === rows.length - 1)).join("")}</div>`,
    `<p style="margin:16px 0;font-size:14px;line-height:1.6;color:#404040;">${escapeHtml(cancelLine)}</p>`,
    `<div style="padding:8px 0;"><a href="${escapeHtml(props.accountUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;border-radius:8px;background-color:#171717;color:#fafafa;font-size:14px;font-weight:600;text-decoration:none;">Open your account</a>&nbsp;&nbsp;<a href="${escapeHtml(props.downloadUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:14px;color:#171717;">Download Engager for Mac</a></div>`,
    `<div style="margin-top:8px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:12px;line-height:16px;color:#737373;">${footer}</div>`,
  ].join("");
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a;">
    <div style="background-color:#f5f5f5;padding:24px;">
      <div style="max-width:480px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e5e5;border-radius:12px;padding:32px;">
        ${body}
      </div>
    </div>
  </body>
</html>`;
  const text = [
    "Your trial has started",
    "",
    intro,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    cancelLine,
    "",
    `Open your account: ${props.accountUrl}`,
    `Download Engager for Mac: ${props.downloadUrl}`,
    "",
    footer,
  ].join("\n");
  return { subject, html, text };
}

export type TrialEndingEmailProps = {
  /** The owner's first name; absent or blank greets "Hi,". */
  firstName: string | null;
  /** Whole days left before the charge, at least 1. The caller counts them
   * from the real clock, so a late delivery never claims more. */
  daysLeft: number;
  /** The subscription's `trial_end`, epoch ms. The first charge lands then. */
  trialEndsAt: number;
  /** The upcoming invoice's amount due (minor units, tax included). */
  chargeAmount: number;
  chargeCurrency: string;
  /** The Stripe Price's amount (minor units), currency and interval. */
  priceAmount: number;
  priceCurrency: string;
  priceInterval: string;
  /** The default payment method's card brand (as Stripe spells it) and last4. */
  cardBrand: string;
  cardLast4: string;
  /** The plan's Mac allowance as the billing offer words it ("One Mac"). */
  seatsLabel: string;
  /** The cloud's `/account`, absolute. */
  accountUrl: string;
};

/**
 * "Your Engager trial ends in N days" (screen 8.1, US-ONI-03). Pure: every
 * figure arrives as a prop from a live Stripe read, and a blank or malformed
 * one throws rather than rendering an email with a hole in it. It states
 * what will be charged and when; it offers nothing and promises nothing else.
 */
export function trialEndingEmail(props: TrialEndingEmailProps): RenderedEmail {
  if (!Number.isInteger(props.daysLeft) || props.daysLeft < 1) {
    throw new Error("trial ending email requires whole days left");
  }
  requireTrialEmailAmount(props.chargeAmount);
  requireTrialEmailAmount(props.priceAmount);
  for (const currency of [props.chargeCurrency, props.priceCurrency]) {
    if (!/^[a-z]{3}$/i.test(currency)) {
      throw new Error("trial email currencies must be ISO codes");
    }
  }
  if (!Number.isFinite(props.trialEndsAt) || props.trialEndsAt <= 0) {
    throw new Error("trial email requires a trial end");
  }
  if (!props.priceInterval.trim()) {
    throw new Error("trial email requires a billing interval");
  }
  if (!props.cardBrand.trim() || !/^\d{4}$/.test(props.cardLast4)) {
    throw new Error("trial email requires the card on file");
  }
  const seatsLabel = props.seatsLabel.trim();
  if (!seatsLabel) {
    throw new Error("trial ending email requires the Mac allowance");
  }
  requireAbsoluteUrl(props.accountUrl);

  const days = `${props.daysLeft} ${props.daysLeft === 1 ? "day" : "days"}`;
  const subject = `Your Engager trial ends in ${days}`;
  const endsOn = trialDate(props.trialEndsAt);
  const heading = `Your trial ends on ${endsOn}`;
  const name = props.firstName?.trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const seats = `${seatsLabel.charAt(0).toLowerCase()}${seatsLabel.slice(1)}`;
  const charge = `On ${endsOn} we'll charge ${formatMoney(props.chargeAmount, props.chargeCurrency)} to your ${cardBrandName(props.cardBrand)} ending ${props.cardLast4}. After that it's ${formatMoney(props.priceAmount, props.priceCurrency)} every ${props.priceInterval.trim()}, for ${seats}.`;
  const keep = `If you're keeping Engager, there's nothing to do. If not, cancel before ${endsOn} and you won't be charged.`;
  const note = `Opens your account on ${new URL(props.accountUrl).host}, where card changes and cancelling go through Stripe.`;
  const footer = "You received this email because you started an Engager trial.";
  const html = layout(
    `<h1 style="margin:0 0 16px 0;font-size:20px;line-height:28px;font-weight:600;color:#18181b;">${escapeHtml(heading)}</h1>` +
      paragraph(escapeHtml(greeting)) +
      paragraph(escapeHtml(charge)) +
      paragraph(escapeHtml(keep)) +
      button(props.accountUrl, "Manage billing") +
      paragraph(escapeHtml(note)),
    footer,
  );
  const text = [
    heading,
    "",
    greeting,
    "",
    charge,
    "",
    keep,
    "",
    `Manage billing: ${props.accountUrl}`,
    "",
    note,
    "",
    footer,
  ].join("\n");
  return { subject, html, text };
}
