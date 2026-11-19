/**
 * The dashboard's route templates, as the enum telemetry is allowed to name.
 *
 * A route is reported as its TEMPLATE (`/campaigns/[campaignId]/strategy/[[...step]]`),
 * never as the path someone visited, so an id, a slug or a query string cannot
 * ride along: the catalog's `route` property is an enum of exactly this list.
 * `apps/dashboard/lib/telemetry/routes.test.ts` fails when a page or route
 * handler exists that is not listed here, so the list cannot drift behind the
 * app. A path that matches none is `other`.
 */
export const DASHBOARD_ROUTES = [
  "/",
  "/api/activity/pulse",
  "/api/activity/stream",
  "/api/campaigns/[campaignId]/activity",
  "/api/channels/probe",
  "/api/channels/relink",
  "/api/chat",
  "/api/chat/sessions",
  "/api/chat/sessions/[id]",
  "/api/health",
  "/api/license/billing",
  "/api/license/billing/callback",
  "/api/license/device",
  "/api/license/email",
  "/api/license/google",
  "/api/license/google/callback",
  "/api/license/logout",
  "/api/license/plan",
  "/api/license/refresh",
  "/api/license/seats",
  "/api/reports",
  "/api/reports/preview",
  "/api/runs/[runId]/steps",
  "/api/setup-state",
  "/api/sidebar",
  "/api/supervision",
  "/api/telemetry",
  "/api/voice/samples",
  "/brain",
  "/brain/products/[id]",
  "/campaigns",
  "/campaigns/[campaignId]",
  "/campaigns/[campaignId]/activity",
  "/campaigns/[campaignId]/changes",
  "/campaigns/[campaignId]/changes/[changeId]",
  "/campaigns/[campaignId]/runs/[runId]",
  "/campaigns/[campaignId]/searches",
  "/campaigns/[campaignId]/strategy/[[...step]]",
  "/channels",
  "/channels/linkedin",
  "/channels/linkedin/changes/[changeId]",
  "/channels/linkedin/limits",
  "/channels/linkedin/live-checks/[check]",
  "/channels/linkedin/your-posts",
  "/chat",
  "/inbox",
  "/leads",
  "/onboarding",
  "/people/[key]",
  "/settings",
  "/settings/account",
  "/settings/agent",
  "/settings/agent/jobs",
  "/settings/agent/models",
  "/settings/agent/setup",
  "/settings/agent/usage",
  "/settings/billing",
  "/settings/mac",
  "/settings/mac/usage-data",
  "/settings/reports",
  "/settings/reports/[id]",
  "/settings/runtime",
  "/signin",
  "/signup",
  "/voice",
  "/voice/history",
  "/voice/new",
  "other",
] as const;

export type DashboardRoute = (typeof DASHBOARD_ROUTES)[number];

const TEMPLATES = DASHBOARD_ROUTES.filter(
  (route): route is Exclude<DashboardRoute, "other"> => route !== "other",
).map((route) => ({
  route,
  segments: route.split("/").filter(Boolean),
}));

/** How many of the template's segments are literal, or null if the path does
 * not fit it. More literal segments win, so `/settings/agent/jobs` is its own
 * route and not an instance of anything dynamic. */
function fit(template: readonly string[], path: readonly string[]): number | null {
  let literal = 0;
  for (let index = 0; index < template.length; index += 1) {
    const part = template[index]!;
    if (part.startsWith("[[...")) return literal;
    if (part.startsWith("[...")) return path.length > index ? literal : null;
    const actual = path[index];
    if (actual === undefined) return null;
    if (part.startsWith("[")) continue;
    if (part !== actual) return null;
    literal += 1;
  }
  return template.length === path.length ? literal : null;
}

/** The template a pathname is an instance of. Only the pathname is read: pass
 * it `location.pathname`, which has no query or fragment to leak. */
export function dashboardRouteFor(pathname: string): DashboardRoute {
  const path = pathname.split("?")[0]!.split("#")[0]!.split("/").filter(Boolean);
  let best: { route: DashboardRoute; literal: number } | null = null;
  for (const { route, segments } of TEMPLATES) {
    const literal = fit(segments, path);
    if (literal !== null && (best === null || literal > best.literal)) best = { route, literal };
  }
  return best?.route ?? "other";
}

/**
 * The route of a server error. Next reports a template (`context.routePath`),
 * sometimes as its file path (`/app/.../page`); when that is not one we list,
 * the request's own pathname is matched instead. Only a template is ever
 * returned, so no id from the path can survive.
 */
export function listedRoute(template: string | undefined, pathname?: string): DashboardRoute {
  if (template !== undefined) {
    const normalized = template.replace(/^\/app(?=\/)/, "").replace(/\/(?:page|route)$/, "");
    const listed = TEMPLATES.find((entry) => entry.route === (normalized || "/"));
    if (listed) return listed.route;
  }
  return pathname === undefined ? "other" : dashboardRouteFor(pathname);
}
