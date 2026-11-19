/**
 * Local-first org bootstrap: find or create the single local organization with
 * exactly one durable owner, so `engager init` can mint ENGAGER_ORG_ID without
 * hand-written SQL. Identity tables (users/organizations/memberships) are
 * deliberately RLS-excluded, so this runs on the ordinary app connection;
 * callers may pass an owner-URL-backed db if app grants ever narrow.
 * Idempotent: re-running returns the existing rows and never creates a second
 * owner for the org.
 */
import { developmentBuild } from "@engager/common/development";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";
import { memberships, organizations, users, type Channel } from "./schema";

export const LOCAL_ORG_SLUG = "local";
export const LOCAL_OWNER_EMAIL = "owner@engager.local";

export type LocalOrgBootstrap = {
  organizationId: string;
  userId: string;
  /** True when this call created the org (vs finding an existing one). */
  createdOrganization: boolean;
  /** True when this call created the owner membership. */
  createdOwner: boolean;
};

export type BootstrapLocalOrgOptions = {
  /** Reuse/create this exact org id (an existing ENGAGER_ORG_ID). */
  organizationId?: string;
  slug?: string;
  organizationName?: string;
  ownerEmail?: string;
  ownerName?: string;
  /**
   * How this org's account is reached, when the caller already knows: `engager
   * init` derives it from the driver the `.env` it just wrote selects, so the
   * minted row states the binding instead of leaving every reader to ask the
   * environment. Omitted, the column default stands — which is what a local
   * install is — and the first successful probe restates it either way.
   */
  connector?: Channel["connector"];
};

export async function bootstrapLocalOrg(
  db: NodePgDatabase<typeof schema>,
  opts: BootstrapLocalOrgOptions = {},
): Promise<LocalOrgBootstrap> {
  const slug = opts.slug ?? LOCAL_ORG_SLUG;
  const email = opts.ownerEmail ?? LOCAL_OWNER_EMAIL;

  // 1. Resolve the organization: by explicit id first, then by slug.
  let org: { id: string } | undefined;
  if (opts.organizationId) {
    [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, opts.organizationId));
  }
  if (!org) {
    const [bySlug] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
    // An explicit org id that doesn't exist must not hijack another org's
    // slug row — mint a distinct slug for it instead.
    if (bySlug && !opts.organizationId) org = bySlug;
  }
  let createdOrganization = false;
  if (!org) {
    const insertSlug =
      opts.organizationId != null
        ? `${slug}-${opts.organizationId.slice(0, 8)}`
        : slug;
    [org] = await db
      .insert(organizations)
      .values({
        ...(opts.organizationId ? { id: opts.organizationId } : {}),
        slug: insertSlug,
        name: opts.organizationName ?? "Local",
      })
      .onConflictDoNothing({ target: organizations.slug })
      .returning({ id: organizations.id });
    if (org) {
      createdOrganization = true;
    } else {
      // Lost a slug race (or slug existed after all) — re-read.
      [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, insertSlug));
    }
  }
  if (!org) throw new Error("bootstrap-local-org: could not create or find the organization");

  // 1b. Every org has a channel row. The migration seeds one per org that
  // existed when it ran; this is the same mint for every org created after —
  // and this is the only org-create path the runtime has. Identity-less on
  // purpose: the row precedes the account identity, which is what lets every
  // later channel-dependent surface assume it exists. `channels` is RLS-forced,
  // so the insert needs the `app.current_org` GUC the policy checks.
  //
  // Idempotent on (org, network) EXISTENCE, not on the identity triple. The
  // unique key is `(org, network, external_account_id)` under NULLS NOT
  // DISTINCT, so once a probe has stamped an identity, `(org,'linkedin',NULL)`
  // and `(org,'linkedin','ada-1')` are DIFFERENT keys — an
  // `onConflictDoNothing` on that triple would not fire, and a re-run of
  // `engager init` (a supported flow: the CLI's own error text tells the owner
  // to re-run it) would mint a SECOND row beside the stamped one. That
  // duplicate is silent until the next successful probe, whose dual-write
  // UPDATE matches on (org, network) — it would set the same identity on both
  // rows and die 23505 on the unique key, breaking liveness recording from
  // then on. Before that it quietly breaks the one-row-per-org premise that
  // `createCampaignOp`'s channel resolve and the channel_id backfill both rely
  // on. Existence on (org, network) is the property actually wanted, so it is
  // the property tested. The unique key stays as the belt.
  //
  // The GUC is set by hand rather than through `withOrg`, which would also run
  // `assertNonSuperuserRole`. That check is deliberately skipped here: this
  // function is documented to accept an OWNER-URL-backed db (see the file
  // header) because it runs during `engager init`, before the app role's grants
  // are necessarily in place — the same reason the identity tables it writes
  // are RLS-excluded. Ordinary tenant work must keep going through `withOrg`.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org', ${org!.id}, true)`);
    // Named only when the caller states one, so an unstated binding falls to
    // the column default rather than to a second copy of it living here. ONE
    // branch for both halves: a column list and a value list that can disagree
    // is a syntax error waiting on the next edit of either.
    const [connectorColumn, connectorValue] = opts.connector
      ? [sql`, "connector"`, sql`, ${opts.connector}`]
      : [sql.empty(), sql.empty()];
    // One statement, so the check and the insert cannot straddle a concurrent
    // init. The organization predicate is spelled out rather than left to the
    // tenant policy: this path accepts an OWNER-URL-backed db, which bypasses
    // RLS. `network` comes from its column default, as does `connector` unless
    // the caller derived one; the two timestamps are app-defaulted with no DB
    // default, hence the explicit clock (0122's seed does the same). The
    // conflict clause is the belt for the still-identity-less race the NOT
    // EXISTS cannot serialize by itself.
    // New installs can post under their campaign approvals and safety gates.
    // Dev remains a no-send test environment. Existing rows are never changed,
    // including an owner who deliberately switched posting off.
    await tx.execute(sql`
      INSERT INTO "channels" ("organization_id", "writes_enabled", "created_at", "updated_at"${connectorColumn})
      SELECT ${org!.id}::uuid, ${!developmentBuild()},
             (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
             (extract(epoch FROM clock_timestamp()) * 1000)::bigint${connectorValue}
       WHERE NOT EXISTS (
             SELECT 1 FROM "channels"
              WHERE "organization_id" = ${org!.id}::uuid
                AND "network" = 'linkedin'
            )
      ON CONFLICT ON CONSTRAINT "channels_org_network_account_key" DO NOTHING
    `);
  });

  // 2. Exactly one durable owner. An existing owner always wins — never add a
  // second one (setupOwnerUserId resolves "the one isOwner membership").
  const [existingOwner] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(eq(memberships.organizationId, org.id), eq(memberships.isOwner, true)),
    );
  if (existingOwner) {
    return {
      organizationId: org.id,
      userId: existingOwner.userId,
      createdOrganization,
      createdOwner: false,
    };
  }

  // 3. Owner user by fixed email (find-or-create).
  let [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ email, name: opts.ownerName ?? "Owner" })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (!user) {
      [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
    }
  }
  if (!user) throw new Error("bootstrap-local-org: could not create or find the owner user");

  await db
    .insert(memberships)
    .values({
      organizationId: org.id,
      userId: user.id,
      role: "admin",
      isOwner: true,
    })
    .onConflictDoNothing();

  return {
    organizationId: org.id,
    userId: user.id,
    createdOrganization,
    createdOwner: true,
  };
}
