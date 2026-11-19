export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const BRAND = "Engager";

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
