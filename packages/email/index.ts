/**
 * @engager/email — server-side transactional email.
 *
 * `sendEmail` is the single send entry point; it resolves the active provider
 * (`getEmailProvider()` → Resend in hosted runtimes, Console only in local/test)
 * and delegates. Convenience senders build a template then `sendEmail`.
 */


import {
  getEmailProvider,
  type EmailPayload,
  type EmailSendOptions,
  type PreparedEmailPayload,
  type SendResult,
} from "./provider";
import {
  emailOtp,
  leadHotEmail,
  leadNudgeEmail,
  orgInviteEmail,
  welcomeEmail,
  type LeadHotEmailProps,
  type LeadNudgeEmailProps,
  type OrgInviteEmailProps,
  type WelcomeEmailProps,
} from "./templates";
export {
  TRIAL_REMINDER_LEAD_DAYS,
  trialEndingEmail,
  trialStartedEmail,
  type TrialEndingEmailProps,
  type TrialStartedEmailProps,
} from "./templates";

export {
  ConsoleEmailProvider,
  EmailProviderError,
  MissingEmailConfigurationError,
  ResendEmailProvider,
  assertEmailDeliveryConfigured,
  getEmailProvider,
} from "./provider";
export type {
  EmailAttachment,
  EmailPayload,
  EmailProvider,
  EmailSendOptions,
  PreparedEmailPayload,
  SendResult,
} from "./provider";

export {
  runtimeAlertEmail,
  leadHotEmail,
  leadNudgeEmail,
  orgInviteEmail,
  welcomeEmail,
} from "./templates";
export type {
  LeadHotEmailProps,
  LeadNudgeEmailProps,
  OrgInviteEmailProps,
  RenderedEmail,
  WelcomeEmailProps,
} from "./templates";

/** Sends an email via Resend, or the local/test Console provider. */
export function sendEmail(
  payload: EmailPayload,
  options?: EmailSendOptions,
): Promise<SendResult> {
  return getEmailProvider().send(payload, options);
}

/** Resolve the sender and freeze the exact provider request without sending. */
export function prepareEmailPayload(
  payload: EmailPayload,
): PreparedEmailPayload {
  return getEmailProvider().prepare(payload);
}

/** Send a previously frozen provider request (including its original sender). */
export function sendPreparedEmail(
  payload: PreparedEmailPayload,
  options?: EmailSendOptions,
): Promise<SendResult> {
  return getEmailProvider().sendPrepared(payload, options);
}

export function sendWelcomeEmail(
  to: string,
  opts: WelcomeEmailProps = {},
): Promise<SendResult> {
  const { subject, html, text } = welcomeEmail(opts);
  return sendEmail({ to, subject, html, text });
}

export function sendEmailOtp(to: string, code: string): Promise<SendResult> {
  const { subject, html, text } = emailOtp({ code });
  return sendEmail({ to, subject, html, text });
}

export function sendOrgInviteEmail(
  to: string,
  opts: OrgInviteEmailProps,
): Promise<SendResult> {
  const { subject, html, text } = orgInviteEmail(opts);
  return sendEmail({ to, subject, html, text });
}

export function sendLeadHotEmail(
  to: string,
  opts: LeadHotEmailProps,
  sendOptions?: EmailSendOptions,
): Promise<SendResult> {
  const { subject, html, text } = leadHotEmail(opts);
  return sendEmail({ to, subject, html, text }, sendOptions);
}

export function sendLeadNudgeEmail(
  to: string,
  opts: LeadNudgeEmailProps,
  sendOptions?: EmailSendOptions,
): Promise<SendResult> {
  const { subject, html, text } = leadNudgeEmail(opts);
  return sendEmail({ to, subject, html, text }, sendOptions);
}

// --- US-ONI-04: payment-failed email (additive; keep separate for merge) ---
export { paymentFailedEmail } from "./templates";
export type { PaymentFailedEmailProps } from "./templates";
