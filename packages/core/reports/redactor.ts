import { REPORT_TITLE_MAX, type ReportWriteUp } from "@engager/common/problem-report";
import { createRedactor, secretValuesFromEnv, type Redactor } from "@engager/observability/redact";
import { reportAccountEmail } from "./sources";

/**
 * The one redactor a problem report passes through on this install, built the
 * same way wherever a report is touched: the diagnostics the owner previews,
 * the Send that stores them, and the agent's write-up (US-BUG-06).
 *
 * The account's email is the one address it leaves in, and only a process that
 * carries the licence gate can read it: it registers the source
 * (`registerReportSources`). Without one, every address is redacted.
 */

/**
 * `knownPeople` is read from the database by the caller (`readKnownPeople`)
 * in a transaction of its own, so building and running the redactor never
 * holds a connection.
 */
export function buildReportRedactor(knownPeople: readonly string[]): Redactor {
  return createRedactor({
    accountEmail: reportAccountEmail(),
    knownSecrets: secretValuesFromEnv(),
    knownPeople,
  });
}

const REDACTED = "(redacted)";

/**
 * The agent's write-up through the redactor. The agent saw only redacted
 * diagnostics, but it also writes prose of its own, and a model can repeat a
 * name from the owner's words or invent one. Its log lines are not touched:
 * they are kept only where the already-redacted diagnostics carry them word
 * for word, and redacting them again could break that match.
 *
 * A field the redactor empties keeps a placeholder: the relay refuses a
 * write-up with an empty title, summary or step, and a report is never held
 * back for want of one.
 */
export function redactWriteUp(writeUp: ReportWriteUp, redactor: Redactor): ReportWriteUp {
  const line = (value: string) => redactor.line(value.replace(/\s*\n\s*/g, " ")) ?? REDACTED;
  const block = (value: string) => redactor.text(value);
  return {
    ...writeUp,
    title: line(writeUp.title).slice(0, REPORT_TITLE_MAX),
    summary: block(writeUp.summary).trim() || REDACTED,
    steps: writeUp.steps.map(line),
    expected: block(writeUp.expected),
    actual: block(writeUp.actual),
  };
}
