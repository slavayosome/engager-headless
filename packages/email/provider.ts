import { createHash } from "node:crypto";

/**
 * Email provider abstraction.
 *
 * Two providers ship: Resend (real delivery) and Console (local/test fallback
 * that logs the complete plaintext email, including action links).
 *
 * The `resend` package is imported LAZILY (dynamic import inside `send`) so that
 * merely importing this module — or running the Console path — does not require
 * the `resend` dependency to be installed.
 */

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

export interface EmailProvider {
  prepare(payload: EmailPayload): PreparedEmailPayload;
  send(payload: EmailPayload, options?: EmailSendOptions): Promise<SendResult>;
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

/**
 * Real delivery via Resend. The Resend SDK is loaded on first `send` so that
 * importing this provider (e.g. for type references or in tests that never call
 * the Resend path) does not require the `resend` package to be present.
 */
export class ResendEmailProvider implements EmailProvider {
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
    const { Resend } = await import("resend");
    const client = new Resend(this.apiKey);
    // Pinned Resend 4.8.0 spreads request options into fetch RequestInit, but
    // its public type exposes only idempotency/query. Keep this compatibility
    // cast narrow so the real fetch receives AbortSignal without widening our API.
    type AbortableResendRequestOptions = NonNullable<
      Parameters<typeof client.emails.send>[1]
    > & { signal?: AbortSignal };
    const requestOptions = {
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    } as AbortableResendRequestOptions;

    let response: Awaited<ReturnType<typeof client.emails.send>>;
    try {
      response = await client.emails.send(
        {
          from: payload.from,
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          text: payload.text ?? "",
          replyTo: payload.replyTo,
          ...(payload.attachments?.length
            ? {
                attachments: payload.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  content: attachment.content,
                  contentType: attachment.contentType,
                })),
              }
            : {}),
        },
        Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
      );
      // Resend currently converts a fetch abort into a generic error response.
      // Restore the caller's abort semantics before interpreting that response.
      options.signal?.throwIfAborted();
    } catch (error) {
      options.signal?.throwIfAborted();
      throw safeProviderError(error);
    }

    if (response.error) {
      throw safeProviderError(response.error);
    }

    return { id: response.data?.id };
  }
}

/**
 * Local/test fallback. The plaintext body is intentionally logged so links are
 * usable without an email vendor. Hosted runtimes may never select this provider.
 */
export class ConsoleEmailProvider implements EmailProvider {
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
export function getEmailProvider(): EmailProvider {
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

/** Fail-fast readiness check used before non-enumerating auth flows branch. */
export function assertEmailDeliveryConfigured(): void {
  void getEmailProvider();
}
