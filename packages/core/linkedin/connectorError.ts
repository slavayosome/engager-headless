/**
 * A CONNECTOR failure — layer 4 of the refusal ladder, and physical only.
 *
 * The ladder is ORG -> WORKER -> CHANNEL -> CONNECTOR, and exactly one layer
 * spends budget: CHANNEL (INV-13). A connector may *fail* what the channel
 * approved — and then it reconciles, never blind-retries (INV-10) — but it may
 * never authorise a send and may never mint a `rate_limit_ledger` row from its
 * own result. Nothing in this file may import from `../ratelimit/`.
 *
 * Named `ConnectorError` and not `ChannelError` on purpose: naming a layer-4
 * error after the layer-3 noun reads as licence to touch the ledger, and the
 * whole reason this type exists is that a physical condition was doing a
 * policy job.
 *
 * WHY IT EXISTS. Nine orchestrator sites classified reschedule-vs-autopause
 * against one connector's own error class, so on any other connector a throttle
 * or a checkpoint on a READ path produced no backoff, no auto-pause and no
 * reschedule: just a consumed job attempt, and another read straight back at
 * LinkedIn.
 *
 * The send path was already covered — the browser driver maps a failed commit
 * onto `{ok: false, retryable, rateLimited}` and the poster branches on it. The
 * gap was reads: discovery, incoming polling, author enrichment, engagement
 * monitoring, lead notification.
 */
export class ConnectorError extends Error {
  /** The connector was told, or inferred, that it is going too fast. */
  readonly rateLimited: boolean;
  /** The account hit an interstitial — a challenge, a verification, a block. */
  readonly checkpoint: boolean;
  /**
   * NOBODY IS SIGNED IN. Reported separately from `checkpoint` because the two
   * are different facts with different remedies, and conflating them cost an
   * account fifteen minutes of pause it had not earned: the browser sidecar's
   * `LOGIN_REQUIRED` was classified as a challenge, so a sweep on a signed-out
   * profile parked the channel as `checkpoint` and every later sweep — on a
   * session the owner had since signed back in — answered `0 found` off the
   * pause (measured 2026-09-15). A challenge is the ACCOUNT under pressure and
   * backs off; a signed-out session is a door, and waiting does not open it.
   */
  readonly signIn: boolean;
  /**
   * The connector read a page whose structure it does not recognise, and
   * refused to guess (the browser sidecar's `UI_DRIFT`). Nothing it read can be
   * trusted, so a caller changes nothing — no row, no watch, no tombstone — and
   * stops reading pages of that kind until the selector pack is fixed. Not a
   * backoff: the account is fine; the reader is out of date.
   */
  readonly drift: boolean;
  /** Worth trying again later at all. */
  readonly retryable: boolean;
  /**
   * Transport status where the connector has one. Optional because a browser
   * connector has no HTTP status to report, and a caller branching on a
   * specific code (a 404 meaning "the comment is gone") must simply not match
   * rather than match on `undefined`.
   */
  readonly status?: number;

  constructor(
    message: string,
    opts: {
      rateLimited?: boolean;
      checkpoint?: boolean;
      signIn?: boolean;
      drift?: boolean;
      retryable?: boolean;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = "ConnectorError";
    this.rateLimited = opts.rateLimited ?? false;
    this.checkpoint = opts.checkpoint ?? false;
    this.signIn = opts.signIn ?? false;
    this.drift = opts.drift ?? false;
    this.retryable = opts.retryable ?? false;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/**
 * Is this a connector saying "not right now"?
 *
 * The one predicate the orchestrator sites share, so a new backoff-worthy
 * condition is added in ONE place rather than in nine `||` chains that drifted
 * apart the first time.
 *
 * `signIn` is deliberately NOT one of them. A backoff parks the account for a
 * window and reschedules into it; a session nobody is signed into is not
 * waiting for a window to pass, and parking it hides the one thing the owner
 * could have done about it behind a pause they never caused.
 */
export function isConnectorBackoff(error: unknown): error is ConnectorError {
  return (
    error instanceof ConnectorError && (error.rateLimited || error.checkpoint)
  );
}

/**
 * Is this a connector saying "nobody is signed in"?
 *
 * Its own predicate, in the same place, because the orchestrator sites need it
 * for the same reason they need the one above: a loop over terms must STOP.
 * A signed-out session will not sign itself in between two searches, so every
 * later term is one more navigation into the same wall — eight of them on the
 * sweep this was found in — and none of them can find anything.
 */
export function isConnectorSignIn(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError && error.signIn;
}

/**
 * Is this a connector saying "I do not recognise this page"?
 *
 * The third predicate beside the two above, for the same loops: a layout the
 * reader does not know is the same layout on the next post, so every further
 * read of that kind spends a page load to learn nothing.
 */
export function isConnectorDrift(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError && error.drift;
}

/**
 * Is this LinkedIn refusing a search as too large — its 413?
 *
 * Neither a backoff nor the account: a finding about the one search, which
 * the sweep counts against it (`discovery/refused.ts` parks a search refused
 * this way twice in a row). Read off `status`, so it holds whichever connector
 * answered.
 */
export function isSearchTooLarge(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError && error.status === 413;
}
