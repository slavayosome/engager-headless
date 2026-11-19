/**
 * The problem report's wire shape: what an install sends the cloud relay
 * (`apps/cloud/app/api/reports`), and the limits both sides hold it to. One
 * module so the sender and the relay cannot disagree about a field or a cap —
 * the job that posts it (`core/jobs/handlers/fileBugReport.ts`), the dialog
 * that bounds what the owner types, and the route that refuses anything else.
 *
 * Dependency-free on purpose: the dashboard's client bundle reads the limits.
 */

export const REPORT_WORDS_MAX = 5_000;
export const REPORT_EXPECTED_MAX = 2_000;
/** Images the owner pastes or drops, beside the one capture of the screen. */
export const REPORT_OWN_IMAGES_MAX = 3;
const MIB = 1024 * 1024;
/**
 * The most a request to the relay may weigh. The relay runs as a Vercel
 * Function, whose request bodies stop at 4.5 MB: a larger one is answered 413
 * by the platform before our route runs, and that report would fail for good.
 * 4 MB leaves half a megabyte under it. Everything below is sized from it.
 */
export const REPORT_BODY_MAX_BYTES = 4 * MIB;
/** All of a report's images together, decoded. Base64 adds a third, so 2.5 MB
 *  weighs 3.33 MB in the request, which leaves 0.67 MB of the body cap for
 *  the diagnostics and for every word, field and bracket around them. The
 *  dialog shrinks images to fit it; the parser refuses what still does not. */
export const REPORT_IMAGES_TOTAL_MAX_BYTES = 2.5 * MIB;
/** The diagnostics as the request carries them — JSON-encoded, in UTF-8 —
 *  not as characters: a character can cost up to six bytes there. Most of what
 *  the images leave; `fitRelayRequest` cuts them further, at the send, when
 *  the rest of a report leaves less. */
export const REPORT_DIAGNOSTICS_MAX_BYTES = 512 * 1024;
export const REPORT_TITLE_MAX = 80;
/** How long a sent report stays on the install that sent it. */
export const REPORT_RETENTION_DAYS = 90;
/** Names the report an upload carries, so the relay can tell a retry of a
 *  report it holds before it reads the body. Only a hint: the body's own id
 *  must match it. */
export const REPORT_ID_HEADER = "x-engager-report-id";

export const REPORT_SEVERITIES = ["blocker", "major", "minor"] as const;
export type ReportSeverity = (typeof REPORT_SEVERITIES)[number];

/** Where the agent thinks the problem lives — the product's own surfaces. */
export const REPORT_AREAS = [
  "inbox",
  "activity",
  "campaigns",
  "scout",
  "voice",
  "brain",
  "channels",
  "linkedin_connection",
  "agent",
  "settings",
  "billing",
  "onboarding",
  "mac_app",
  "other",
] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];

export const REPORT_DEPLOYMENTS = ["mac_app", "browser", "hosted"] as const;
export type ReportDeployment = (typeof REPORT_DEPLOYMENTS)[number];

export const REPORT_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;
export type ReportImageType = (typeof REPORT_IMAGE_TYPES)[number];

/** The screen the owner reported from: its breadcrumb, never a raw URL, beside
 *  the route template and the ids that fill it. */
export type ReportScreen = {
  label: string;
  route: string;
  params: Record<string, string>;
  title: string;
  viewport: { width: number; height: number };
  theme: "light" | "dark";
};

export type ReportApp = {
  version: string;
  build: string | null;
  os: string;
  deployment: ReportDeployment;
};

/** The owner's agent's write-up. Its log lines are quoted from the redacted
 *  diagnostics only. */
export type ReportWriteUp = {
  title: string;
  summary: string;
  steps: string[];
  expected: string;
  actual: string;
  area: ReportArea;
  severity: ReportSeverity;
  logLines: string[];
};

export type ReportScreenshot = {
  contentType: ReportImageType;
  /** base64 */
  content: string;
};

/** Why a report carries diagnostics or not: they are in it, the owner
 *  unticked them, or the install could not prepare them. The team reads this,
 *  so "unticked" must never stand for the other. */
export const REPORT_DIAGNOSTICS_STATUSES = ["included", "unticked", "unavailable"] as const;
export type ReportDiagnosticsStatus = (typeof REPORT_DIAGNOSTICS_STATUSES)[number];

export type ProblemReport = {
  /** The report's own id and its idempotency key, end to end. */
  id: string;
  installId: string;
  screen: ReportScreen;
  /** The owner's words, verbatim — never rewritten by anyone. */
  words: string;
  expected: string | null;
  app: ReportApp;
  /** Redacted diagnostics, or null when the owner unticked them or they could
   *  not be prepared (`diagnosticsStatus` says which). */
  diagnostics: string | null;
  diagnosticsStatus: ReportDiagnosticsStatus;
  writeUp: ReportWriteUp | null;
  /** Why there is no write-up: a reason class, never an error's text. */
  writeUpUnavailable: string | null;
  screenshots: ReportScreenshot[];
};

/** How the install proves who it is. A licence refresh token resolves the
 *  account the team replies to; an install without one reports anonymously. */
export type ReportCredential = { kind: "licence"; refreshToken: string };

export type ReportRelayRequest = {
  report: ProblemReport;
  credential: ReportCredential | null;
};

/** The relay's answer. `sent` is the only success, and it carries the
 *  provider's message id: the relay never answers 2xx for a report it did not
 *  send. */
export type ReportRelayResponse =
  | { status: "sent"; messageId: string; duplicate?: boolean }
  | { error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALL_ID = /^[0-9a-f]{32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isReportId(value: unknown): value is string {
  return isUuid(value);
}

/** What a string costs inside the request: JSON-encoded, in UTF-8. */
export function jsonBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Whether diagnostics are text, and fit the request. */
export function diagnosticsFit(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && jsonBytes(value) <= REPORT_DIAGNOSTICS_MAX_BYTES;
}

const TRUNCATED_NOTICE = "\n… diagnostics truncated to fit the report\n";

/**
 * Diagnostics held to `max` bytes in the request (the diagnostics cap unless
 * a caller has less room): whole when they fit, else the longest head that
 * fits beside a notice saying so. The relay refuses a request over its cap,
 * and a refusal fails the report for good; a long log tail is the one thing a
 * report can lose without losing its point.
 */
export function fitDiagnostics(text: string, max = REPORT_DIAGNOSTICS_MAX_BYTES): string {
  if (jsonBytes(text) <= max) return text;
  const room = max - jsonBytes(TRUNCATED_NOTICE);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(0, mid)) <= room) low = mid;
    else high = mid - 1;
  }
  // Never cut between the halves of a surrogate pair.
  const code = text.charCodeAt(low - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? low - 1 : low;
  return text.slice(0, end) + TRUNCATED_NOTICE;
}

/** What a request weighs on the wire: its JSON, in UTF-8. */
export function requestBytes(request: ReportRelayRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).length;
}

/**
 * The request, with its diagnostics cut to what is left of the body cap once
 * everything else in it is counted. Images at their cap and a write-up in the
 * widest characters can leave the diagnostics less than their own cap; they
 * are the part a report can lose, so they go short and say so, and the
 * request is never over what the relay takes.
 */
export function fitRelayRequest(request: ReportRelayRequest): ReportRelayRequest {
  const { diagnostics } = request.report;
  if (diagnostics === null) return request;
  // With the diagnostics as "": the rest of the request, and the two quotes
  // that `jsonBytes` counts with the diagnostics themselves.
  const rest = requestBytes({ ...request, report: { ...request.report, diagnostics: "" } }) - 2;
  const room = REPORT_BODY_MAX_BYTES - rest;
  if (jsonBytes(diagnostics) <= room) return request;
  return { ...request, report: { ...request.report, diagnostics: fitDiagnostics(diagnostics, room) } };
}

/**
 * Whether base64 content opens with the signature its declared type claims. A
 * report's images are forwarded to the team as attachments, so a file that
 * says it is a PNG and is something else is refused rather than relayed.
 */
export function hasImageSignature(contentType: ReportImageType, content: string): boolean {
  let head: string;
  try {
    // The first 12 bytes, as 16 base64 characters.
    head = atob(content.slice(0, 16));
  } catch {
    return false;
  }
  const bytes = [...head].map((char) => char.charCodeAt(0));
  const signature = contentType === "image/png" ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff];
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Bytes a base64 string decodes to, without decoding it. */
export function base64Bytes(content: string): number {
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return Math.floor((content.length * 3) / 4) - padding;
}

/**
 * The whole request, or null. Strict: an unknown key anywhere, a field over
 * its cap or a value outside its set refuses the request — the relay never
 * forwards what it did not expect.
 */
export function parseReportRelayRequest(value: unknown): ReportRelayRequest | null {
  if (!isRecord(value) || !onlyKeys(value, ["report", "credential"])) return null;
  const report = parseReport(value.report);
  if (!report) return null;
  const credential = value.credential == null ? null : parseCredential(value.credential);
  if (value.credential != null && !credential) return null;
  return { report, credential };
}

function parseReport(value: unknown): ProblemReport | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "id",
      "installId",
      "screen",
      "words",
      "expected",
      "app",
      "diagnostics",
      "diagnosticsStatus",
      "writeUp",
      "writeUpUnavailable",
      "screenshots",
    ])
  ) {
    return null;
  }
  const screen = parseScreen(value.screen);
  const app = parseApp(value.app);
  const writeUp = value.writeUp == null ? null : parseWriteUp(value.writeUp);
  const screenshots = parseScreenshots(value.screenshots);
  if (
    !isReportId(value.id) ||
    typeof value.installId !== "string" ||
    !INSTALL_ID.test(value.installId) ||
    !screen ||
    !app ||
    !text(value.words, REPORT_WORDS_MAX) ||
    !(value.expected === null || text(value.expected, REPORT_EXPECTED_MAX)) ||
    !(value.diagnostics === null || diagnosticsFit(value.diagnostics)) ||
    !(REPORT_DIAGNOSTICS_STATUSES as readonly unknown[]).includes(value.diagnosticsStatus) ||
    // `included` is exactly the case that carries them.
    (value.diagnosticsStatus === "included") !== (value.diagnostics !== null) ||
    (value.writeUp != null && !writeUp) ||
    !(value.writeUpUnavailable === null || text(value.writeUpUnavailable, 200)) ||
    !screenshots
  ) {
    return null;
  }
  return {
    id: value.id,
    installId: value.installId,
    screen,
    words: value.words as string,
    expected: value.expected as string | null,
    app,
    diagnostics: value.diagnostics as string | null,
    diagnosticsStatus: value.diagnosticsStatus as ReportDiagnosticsStatus,
    writeUp,
    writeUpUnavailable: value.writeUpUnavailable as string | null,
    screenshots,
  };
}

/** Exported for the install's own submit route, which holds a screen to the
 *  same bar before it is stored. */
export function parseScreen(value: unknown): ReportScreen | null {
  if (!isRecord(value) || !onlyKeys(value, ["label", "route", "params", "title", "viewport", "theme"])) return null;
  const { label, route, params, title, viewport, theme } = value;
  if (
    !text(label, 300) ||
    !text(route, 300) ||
    !(route as string).startsWith("/") ||
    !text(title, 300, true) ||
    !isRecord(params) ||
    Object.keys(params).length > 10 ||
    !Object.values(params).every((v) => text(v, 200)) ||
    !isRecord(viewport) ||
    !onlyKeys(viewport, ["width", "height"]) ||
    !dimension(viewport.width) ||
    !dimension(viewport.height) ||
    (theme !== "light" && theme !== "dark")
  ) {
    return null;
  }
  return {
    label: label as string,
    route: route as string,
    params: params as Record<string, string>,
    title: title as string,
    viewport: { width: viewport.width as number, height: viewport.height as number },
    theme,
  };
}

function parseApp(value: unknown): ReportApp | null {
  if (!isRecord(value) || !onlyKeys(value, ["version", "build", "os", "deployment"])) return null;
  if (
    !text(value.version, 40) ||
    !(value.build === null || text(value.build, 80)) ||
    !text(value.os, 120) ||
    !(REPORT_DEPLOYMENTS as readonly unknown[]).includes(value.deployment)
  ) {
    return null;
  }
  return {
    version: value.version as string,
    build: value.build as string | null,
    os: value.os as string,
    deployment: value.deployment as ReportDeployment,
  };
}

/** Exported for the job, which holds the agent's answer to the same bar. */
export function parseWriteUp(value: unknown): ReportWriteUp | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["title", "summary", "steps", "expected", "actual", "area", "severity", "logLines"])
  ) {
    return null;
  }
  const { title, summary, steps, expected, actual, area, severity, logLines } = value;
  if (
    !text(title, REPORT_TITLE_MAX) ||
    !text(summary, 4_000) ||
    !Array.isArray(steps) ||
    steps.length > 20 ||
    !steps.every((s) => text(s, 500)) ||
    !text(expected, 2_000, true) ||
    !text(actual, 2_000, true) ||
    !(REPORT_AREAS as readonly unknown[]).includes(area) ||
    !(REPORT_SEVERITIES as readonly unknown[]).includes(severity) ||
    !Array.isArray(logLines) ||
    logLines.length > 40 ||
    !logLines.every((l) => text(l, 2_000))
  ) {
    return null;
  }
  return {
    title: title as string,
    summary: summary as string,
    steps: steps as string[],
    expected: expected as string,
    actual: actual as string,
    area: area as ReportArea,
    severity: severity as ReportSeverity,
    logLines: logLines as string[],
  };
}

export function parseScreenshots(value: unknown): ReportScreenshot[] | null {
  if (!Array.isArray(value) || value.length > REPORT_OWN_IMAGES_MAX + 1) return null;
  const shots: ReportScreenshot[] = [];
  let total = 0;
  for (const shot of value) {
    if (!isRecord(shot) || !onlyKeys(shot, ["contentType", "content"])) return null;
    if (
      !(REPORT_IMAGE_TYPES as readonly unknown[]).includes(shot.contentType) ||
      typeof shot.content !== "string" ||
      shot.content.length === 0 ||
      !BASE64.test(shot.content) ||
      !hasImageSignature(shot.contentType as ReportImageType, shot.content)
    ) {
      return null;
    }
    total += base64Bytes(shot.content);
    if (total > REPORT_IMAGES_TOTAL_MAX_BYTES) return null;
    shots.push({ contentType: shot.contentType as ReportImageType, content: shot.content });
  }
  return shots;
}

function parseCredential(value: unknown): ReportCredential | null {
  if (!isRecord(value)) return null;
  if (value.kind === "licence" && onlyKeys(value, ["kind", "refreshToken"])) {
    return typeof value.refreshToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.refreshToken)
      ? { kind: "licence", refreshToken: value.refreshToken }
      : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, max: number, allowEmpty = false): boolean {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0);
}

function dimension(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 20_000;
}
