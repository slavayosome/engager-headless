import { createHash } from "node:crypto";

const DEFAULT_FROM = "Engager <noreply@example.com>";

/** A file carried with an email: its bytes as base64, the way the provider's
 *  API takes them. */
export type EmailAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
};

/** Exact request handed to the provider. Unlike EmailPayload this includes the
 * resolved sender, so an ACK-before-receipt retry is byte-for-byte stable even
 * if deployment configuration changes. */
export type PreparedEmailPayload = EmailPayload & { from: string };

export type SendResult = { id?: string };
export type EmailSendOptions = {
  idempotencyKey?: string;
  signal?: AbortSignal;
};

interface EmailProvider {
  prepare(payload: EmailPayload): PreparedEmailPayload;
  sendPrepared(
    payload: PreparedEmailPayload,
    options?: EmailSendOptions,
  ): Promise<SendResult>;
}

export class MissingEmailConfigurationError extends Error {
  constructor(message = "Hosted transactional email is not fully configured.") {
    super(message);
    this.name = "MissingEmailConfigurationError";
  }
}

/** Safe operational error: provider responses can echo recipient addresses or
 * action URLs, so only a category/status and correlation digest may escape. */
export class EmailProviderError extends Error {
  constructor(
    readonly category: string,
    readonly digest: string,
    readonly status?: number,
  ) {
    super(
      `Email provider request failed (${[
        category,
        status == null ? undefined : String(status),
        digest.slice(0, 16),
      ]
        .filter(Boolean)
        .join(":")}).`,
    );
    this.name = "EmailProviderError";
  }
}

function safeProviderError(error: unknown): EmailProviderError {
  if (error instanceof EmailProviderError) return error;
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  const token = (value: unknown): string | undefined =>
    typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
      ? value
      : undefined;
  let raw: string;
  if (error instanceof Error) raw = `${error.name}\0${error.message}`;
  else if (typeof error === "string") raw = error;
  else {
    try {
      raw = JSON.stringify(error) ?? "unknown";
    } catch {
      raw = Object.prototype.toString.call(error);
    }
  }
  const statusValue = Number(record?.status ?? record?.statusCode);
  const status =
    Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599
      ? statusValue
      : undefined;
  return new EmailProviderError(
    token(record?.name) ??
      token(record?.code) ??
      token(error instanceof Error ? error.name : undefined) ??
      "provider_error",
    createHash("sha256").update(raw, "utf8").digest("hex"),
    status,
  );
}

function hostedSenderAddress(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;
  const bracketed = configured.match(/<([^<>]+)>\s*$/)?.[1]?.trim();
  const address = (bracketed ?? configured).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  const domain = address.split("@")[1];
  if (
    !domain ||
    domain === "example.com" ||
    domain === "example.test" ||
    domain === "localhost" ||
    domain.endsWith(".invalid")
  ) {
    return null;
  }
  return address;
}

function isHostedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  // Platform evidence wins over a contradictory app label. A bad Vercel env
  // value must never turn verification/reset delivery into Console logging.
  if (
    env.VERCEL_ENV === "production" ||
    env.VERCEL_ENV === "preview" ||
    env.VERCEL_ENV === "development" ||
    env.VERCEL_GIT_COMMIT_REF === "main" ||
    env.VERCEL_GIT_COMMIT_REF === "develop"
  ) {
    return true;
  }

  const configured = env.ENGAGER_DEPLOYMENT_ENV?.trim();
  if (configured === "dev" || configured === "prod" || configured === "cloud") return true;
  // A tenant without a delivery key must refuse mail, never log its body.
  if (configured === "local" || configured === "test") {
    return false;
  }
  if (configured) {
    throw new Error(
      `Invalid ENGAGER_DEPLOYMENT_ENV "${configured}" for email delivery.`,
    );
  }

  return false;
}

class ResendEmailProvider implements EmailProvider {
  private readonly apiKey: string;
  private readonly from: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.from = process.env.ENGAGER_EMAIL_FROM ?? DEFAULT_FROM;
  }

  prepare(payload: EmailPayload): PreparedEmailPayload {
    return { ...payload, from: this.from };
  }

  async send(
    payload: EmailPayload,
    options: EmailSendOptions = {},
  ): Promise<SendResult> {
    return this.sendPrepared(this.prepare(payload), options);
  }

  async sendPrepared(
    payload: PreparedEmailPayload,
    options: EmailSendOptions = {},
  ): Promise<SendResult> {
    options.signal?.throwIfAborted();
    const headers = new Headers({
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    });
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    const baseUrl = process.env.RESEND_BASE_URL || "https://api.resend.com";
    try {
      const response = await fetch(`${baseUrl}/emails`, {
        method: "POST",
        headers,
        signal: options.signal,
        body: JSON.stringify({
          from: payload.from,
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          text: payload.text ?? "",
          reply_to: payload.replyTo,
          attachments: payload.attachments?.map(({ filename, content, contentType }) => ({
            filename, content, content_type: contentType,
          })),
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw safeProviderError({ ...error, status: response.status });
      }
      const result = await response.json();
      if (typeof result?.id !== "string" || !result.id) {
        throw new Error("Resend did not return a delivery ID");
      }
      return { id: result.id };
    } catch (error) {
      options.signal?.throwIfAborted();
      throw safeProviderError(error);
    }
  }
}

/**
 * Local/test fallback. The plaintext body is intentionally logged so links are
 * usable without an email vendor. Hosted runtimes may never select this provider.
 */
class ConsoleEmailProvider implements EmailProvider {
  prepare(payload: EmailPayload): PreparedEmailPayload {
    return {
      ...payload,
      from: process.env.ENGAGER_EMAIL_FROM?.trim() || DEFAULT_FROM,
    };
  }

  async send(
    payload: EmailPayload,
    options: EmailSendOptions = {},
  ): Promise<SendResult> {
    return this.sendPrepared(this.prepare(payload), options);
  }

  async sendPrepared(
    payload: PreparedEmailPayload,
    options: EmailSendOptions = {},
  ): Promise<SendResult> {
    options.signal?.throwIfAborted();
    // eslint-disable-next-line no-console
    // Attachments by name only: their bytes are no use in a terminal.
    const attached = payload.attachments?.length
      ? ` attachments=${payload.attachments.map((a) => a.filename).join(",")}`
      : "";
    console.info(
      `[email:console] would send → from=${payload.from} to=${payload.to} subject=${JSON.stringify(payload.subject)}${attached}\n${payload.text ?? payload.html}`,
    );
    return {};
  }
}

/**
 * Returns Resend when configured. Console is allowed only for local/test; hosted
 * runtimes fail closed so verification/reset flows never claim a no-op email was
 * delivered.
 */
function getEmailProvider(): EmailProvider {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const hosted = isHostedRuntime();
  if (apiKey) {
    if (hosted && !hostedSenderAddress(process.env.ENGAGER_EMAIL_FROM)) {
      throw new MissingEmailConfigurationError(
        "ENGAGER_EMAIL_FROM must be a non-placeholder sender on a Resend-verified domain in hosted runtimes.",
      );
    }
    return new ResendEmailProvider(apiKey);
  }
  if (hosted) {
    throw new MissingEmailConfigurationError(
      "RESEND_API_KEY is required in hosted runtimes.",
    );
  }
  return new ConsoleEmailProvider();
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
