/**
 * `docs/generated/telemetry.md`, rendered from the catalog. The same text is
 * what the Privacy Policy's "Usage data" section summarises, so it is built
 * from `events.ts` and nothing else: if an event or a property exists, it is
 * listed here; if it is listed here, it exists.
 */
import {
  NEVER_COLLECTED,
  RELAY_EVENTS_PER_INSTALL_PER_DAY,
  TELEMETRY_QUESTIONS,
  describeContext,
  describeEvents,
  type PropertyDescription,
} from "./events";

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** What a property may hold, in the words an owner reads. */
export function propertyValues(property: PropertyDescription): string {
  switch (property.kind) {
    case "enum":
      return property.values.length > 24
        ? `one of ${property.values.length} fixed names (${property.values.slice(0, 3).join(", ")}, ...)`
        : property.values.map((value) => `\`${value}\``).join(", ");
    case "count":
      return "a number";
    case "flag":
      return "yes or no";
    case "version":
      return "a version number";
    case "hashed id":
      return "a one-way hash (16 characters)";
    case "commit":
      return "the build's commit hash";
  }
}

export function renderTelemetryMarkdown(): string {
  const events = describeEvents();
  const context = describeContext();
  const questions = Object.entries(TELEMETRY_QUESTIONS)
    .map(([id, text]) => `- **${id}.** ${text}`)
    .join("\n");
  const never = NEVER_COLLECTED.map((item) => `- ${item}`).join("\n");
  const contextRows = context
    .map((property) => `| \`${property.name}\` | ${cell(propertyValues(property))} |`)
    .join("\n");
  const sections = events
    .map((event) => {
      const rows =
        event.properties.length === 0
          ? "_No properties._"
          : `| Property | Allowed values |\n| --- | --- |\n${event.properties
              .map(
                (property) =>
                  `| \`${property.name}\`${property.optional ? " (optional)" : ""} | ${cell(propertyValues(property))} |`,
              )
              .join("\n")}`;
      return `### \`${event.name}\`

${event.description}

Answers ${event.questions.join(", ")}. ${
        event.sentBy === "service"
          ? "Sent by Engager's own service, never by an install."
          : `Sent at most ${event.maxPerInstallPerDay} ${event.maxPerInstallPerDay === 1 ? "time" : "times"} a day by one running process.`
      }

${rows}`;
    })
    .join("\n\n");
  return `# Usage data

Engager shares anonymous usage data from every install to improve the product:
what you use and what fails, never your posts, comments, messages or the people
you talk to. It is disclosed in the Terms and the Privacy Policy and has no
owner-facing switch. Every event is declared in
\`packages/observability/events.ts\`; this page is generated from that file.

Every property of every event is a fixed name, a number, a yes or no, a version
number or a one-way hash. There is no field that can hold text.

## Why it is collected

An event that answers none of these questions is not added.

${questions}

## Never collected

${never}

## Sent with every event

The same few facts about the install ride on each event. None of them names you.

| Property | Allowed values |
| --- | --- |
${contextRows}

The install itself is a random id minted on this machine. Organisations are a
group keyed by a one-way hash.

## How much is sent

Each event has a daily cap. Each running process of Engager counts its own (the
app and its agent are separate processes) from midnight UTC, drops what is over
its cap and says so once a day with a \`telemetry_dropped\` event. The only limit
across the whole install is the relay's: it accepts at most ${RELAY_EVENTS_PER_INSTALL_PER_DAY.toLocaleString("en-US")}
events a day from one install and drops the rest.

## IP addresses

No event carries an IP address, and the client sends none. The relay sees the
address a request comes from, as any server does. It uses it only to rate-limit,
keeps only a keyed hash of it for a short while and forwards none of it. PostHog
never receives it.

## Events

${sections}
`;
}
