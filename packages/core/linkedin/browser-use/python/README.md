# Engager Browser Use sidecar spike

This is an intentionally narrow, local NDJSON bridge. It pins
`cdp-use==1.4.5` and drives Chromium over CDP directly
(`engager_browser_use/chromium.py`); it exposes Engager operations only.

Run it through the locked project environment:

```sh
uv run --project packages/core/linkedin/browser-use/python --locked \
  python -u packages/core/linkedin/browser-use/python/bridge.py \
  --profile-dir "$ENGAGER_BROWSER_PROFILE_DIR"
```

The first stdout line is the v1 `ready` event. Every later stdout line is the
response to one `{v,id,op,params}` request. Logs go to stderr. The process is
single-account and serializes browser work; its JSON write journal takes an
exclusive process lock.

The sidecar holds no write gate of its own. The owner's live-writes switch is
the one gate: a driver built with it off never sends a write request, and every
write routes through the canonical safety and posting path.

The browser profile must be dedicated to Engager. The default path is
`~/.engager/browser-profile`. On the first headed run, sign in to LinkedIn in
that visible browser and call `ensure_session` again. Alternatively set
`ENGAGER_BROWSER_CDP_URL` to attach to a Chrome instance that the user launched
with remote debugging.

The launched browser is headed but hidden by default on macOS. The owner's
choice on Settings › This Mac, saved as `browser-window.json` beside the profile
(`{"window": "hidden" | "shown"}`), is read at every launch; without one,
`ENGAGER_BROWSER_HIDDEN` (or the `--browser-hidden` bridge flag; `false` for a
visible window) decides. A hidden browser is created off every display, so no
frame of it reaches the screen at launch, and the app is then hidden as well —
same mechanism as ⌘H — so unattended runs never steal focus, while the
fingerprint stays fully headed. An `ensure_session` with
`{"interactive": true}` (what the dashboard's Test connection sends) brings the
window back to the front so the owner can sign in, and reads again who is
signed in rather than answering from what it learned earlier. Three more keys
serve the setup window's sign-in step: `"surface": false` makes an interactive
probe only WATCH (the window stays where the owner has it, and one they closed
stays closed, answering `browser_closed`), `"signIn": true` goes to LinkedIn's
own sign-in page first, and `"place": {"left", "top", "width", "height"}` is
the screen area a surfaced window is put in. The answer's `account` carries the
mini profile's `headline` beside the name and handle, for that step to show;
nothing keeps it. `set_window_visibility`
applies a new choice at once (`{"window": …}`) or brings the window up for the
session (`{"reveal": true}`, with the same `place`), and the next unattended op
hides it again. `restart_browser` (`{}`, or `{"place": …}`) is the sign-in step's
Try again: it closes the browser, waits for the exit so the profile's cookies are
flushed, closes a leftover Chromium holding the profile, starts the browser again
on the same profile and brings its window up as a reveal does. It opens and
navigates no page, and never touches the profile's files. `close_browser` (`{}`)
is the first half alone, for a Disconnect about to archive the profile: the
browser closes, its cookies flushed, and the next operation starts one again.
Hiding uses one `osascript` System Events call; the first one triggers macOS's
one-time Automation permission prompt for the process running the sidecar. A
denial falls back to parking the window off-screen over CDP, and when neither
works the sidecar records it in `browser-window-state.json`, which the
dashboard reads to say so. A CDP attach is a browser we do not own and is
never hidden.

Page media — LinkedIn's image, document and video hosts — is left alone by
default and blocked at the network layer when `ENGAGER_BROWSER_BLOCK_MEDIA` is
`true`. The hosted placement sets it, because every byte it loads crosses a
paid residential proxy and the DOM this sidecar reads needs none of them; a CDP
attach on its own never does, since that is equally a Chrome the owner launched
and may be watching. Set it either way to override. Scripts and stylesheets are
never blocked.

Writes are two-phase, and since 2026-10-21 a comment, a reply and a like are
made as LinkedIn's own client makes them — one POST to its API, from the post's
own page — with no composer typed into and no control pressed
(`comment_write.py` names where in the client's bundle each request is read
from):

- a comment or a reply: `POST /voyager/api/voyagerSocialDashNormComments?
  decorationId=com.linkedin.voyager.dash.deco.social.NormComment-44` with
  `{commentary: {text, attributesV2: [], $type: "com.linkedin.voyager.dash.
  common.text.TextViewModel"}, threadUrn}` — the owner's words exactly, no
  mention or formatting added; `threadUrn` the post's for a comment, the
  comment's own for a reply;
- a like: `POST /voyager/api/voyagerSocialDashReactions?threadUrn=<thread>`
  with `{reactionType: "LIKE"}`.

Each POST goes from the post's page — opened at the comment, by LinkedIn's own
link to it, where the write answers or likes one — through the window
LinkedIn's API client runs in (the redesign's `/preload/` frame, else the page),
with the CSRF token and the headers that page's own client names it by
(`page_visit.py`: `x-li-page-instance`, `x-li-track`, `x-li-lang`), accepting
`application/vnd.linkedin.normalized+json+2.1`.

1. `write` performs author-verified reconciliation, opens the post's
   page (kept from the reconcile read before it, and for the like after it, for
   `POST_VISIT_REUSE_S`) and reads LinkedIn's data from it: the post asked for by the urn the
   owner approved (`feed/updatesV2?q=backendUrnOrNss`), whose update must be
   that post or carry it, and whose thread — its socialDetail's `urn`, the
   dash socialDetail's first key, its counts' `urn`, all one — must be the
   approved post or the content it carries (`THREAD_MISMATCH` otherwise), with
   the viewer's `canPostComments` (`COMMENTS_CLOSED` otherwise). What the
   POST will send is fixed here and journaled with the attempt
   (`commentPrepared`, or a reply's `replyPrepared`). Nothing is sent.
2. It keeps the tab on that page, or opens it again where it has left, in the
   same browser session, holding the session cookie (`PREPARED_UI_STALE`
   otherwise), re-verifies the connected account (from `/voyager/api/me`, else
   the account's own profile data — never a heading; neither answering is
   `ACCOUNT_IDENTITY_UNAVAILABLE`, retryable, and nothing is sent) for the last
   time BEFORE `CLICKING` is made durable, so a probe that cannot answer
   journals nothing. Then it durably records `CLICKING` — the attempt's first
   journal write — and makes exactly one POST.
3. A 2xx naming the one comment it created — on this post, with these words,
   none of ours from before — is `CONFIRMED` with its urn as LinkedIn keys it,
   `urn:li:comment:(<post>,<id>)`. A 4xx (other than 408/409/425/429) is
   LinkedIn's refusal: `BLOCKED`, answered `failed` with `WRITE_REFUSED` (a
   room reply's `ROOM_REPLY_REFUSED`) and its words, and never sent again.
   Anything else — no answer, a timeout, a 5xx, an answer this does not read —
   is read back from LinkedIn's comment data at once (`WRITE_READ_BACKS`),
   which can only find it: a comment of ours with these words written since the
   POST, a reply not among ours at prepare. Not found, it is `UNCERTAIN` with
   what LinkedIn answered. `write` cannot send
   again from `CLICKING`/`UNCERTAIN`; only `reconcile_posted` or manual
   resolution follows.

What LinkedIn answers a create with is UNVERIFIED live — no write was made to
read it: the reader takes the client's own (`singleComment.elements[0]`, a dash
comment beside its NormComment) and fails closed to the read back.

A comment's read back and its `reconcile_posted` read LinkedIn's own comment data
(`comment_data.py`): the post's `feed/comments`, newest first where LinkedIn
answers that order (REVERSE_CHRONOLOGICAL, UNVERIFIED live, else the RELEVANCE
`read_post_thread` has read), for a comment written by this account whose words
hash to ours — for an attempt sent under the journal, written since it was sent
(`clickStartedAt`, LinkedIn's clock allowed `READ_BACK_SKEW_MS`), so an
identical older comment of ours never stands in for it. The urn it lists is the
receipt, whether or not the post's page shows the comment. "Not posted" (a
`None` from `reconcile_posted`) comes only from a WHOLE read: every comment
`paging.total` counts listed, none of them without an author. A read that stops
short of one raises `THREAD_INCOMPLETE`, a post whose comment data does not
answer raises `THREAD_UNAVAILABLE`, and `write` carries on past either
only where no POST is on record. The page's markup (`COMMENTS_JS`) stays as a
fallback that can find a comment and never deny it — never for a sent attempt,
for the markup carries no time.

A reply (`kind: "reply"`, added 2026-10-11) rides the same journal and the same
steps. Its input names the post, `parentCommentUrn` — the comment of ours
it is posted under — and `replyToUrn`, the reply it answers: LinkedIn threads
are two levels deep, so an answer to a reply under our comment is posted into
our comment's thread, beside it. `write` opens the post at the reply it
answers and reads LinkedIn's data only (`reply_write.py`): the post's thread,
open to comments; our comment among the post's comments, still ours and open
to replies (`reply_parent`) — its urn as LinkedIn lists it is the thread the
reply goes in, refused unless it is on this post; and the reply being answered
among our comment's replies, by someone else (`check_reply_target`) — or, in a
room's thread, newer than our room reply there. A comment the read did not
reach is `THREAD_INCOMPLETE`, one gone `REPLY_TARGET_UNAVAILABLE`. The journal
keeps, beside the attempt, our replies already under the comment and the body
— exactly the owner's words. `write` confirms from LinkedIn's answer, or
from a read of our comment's replies showing a direct reply of ours whose words
hash to the body and that was not among ours at prepare — so an identical older
reply of ours never stands in for this one. `reconcile_posted` judges by the
same evidence, adopts nothing for an operation never prepared, and answers "not
posted" from a whole read of the data only — a read short of a reply LinkedIn
counts is `THREAD_INCOMPLETE`, one only the page answered is
`THREAD_UNAVAILABLE`. An attempt prepared by the page's composer before
2026-10-21 is reconciled by its own evidence, as it always was. A room reply
(`kind: "room_reply"`) is the same POST into a third party's comment, the
comment's author held to the member it was bound to (`check_room_parent`).

For an explicit human `confirmed_not_posted` decision, call
`resolve_write_outcome` with the same marker/input and the canonical
post-resolution `redraftRequestVersion` before re-arming the cloud message. It
performs a final reconciliation and durably records `RESOLVED_NOT_POSTED`.
Only that state permits another attempt. Same/lower resolution
versions cannot clear a later attempt, and a confirmed receipt can never be
downgraded. A pre-journal cloud ambiguity can use the same explicit handshake because
no click was issued.

An invitation, acceptance, withdrawal or DM nobody saw land is closed the same
way by `settle_member_write` (`operationId`, `outcome`: `went_out` or
`not_sent`): the owner's word is recorded in its entry, and nothing is read or
pressed. An entry the sidecar settled the other way answers `contradicted`.

Normal tests use a fake backend and never start a browser or contact LinkedIn:

```sh
uv run --directory packages/core/linkedin/browser-use/python --locked \
  python -m unittest discover -s tests
```

## Spike assumptions

- `like_post` likes the post being commented on, because `likeWhenCommenting`
  defaults true and every canonical comment calls it. It is gated by the same
  live-writes switch as a comment, but takes no journal
  entry of the sidecar's — the core's action ledger holds the like, and
  `like_outcome` its receipt: the op opens the post's page, reads how the
  account stands with the post — its document's declared `reactionState-`
  (`like_data.py`) and its counts in LinkedIn's data (`liked`/`reacted`),
  together (`like_data.combined_reaction`) — and reports `already_liked` for a
  Like there with nothing sent, refuses `ALREADY_REACTED` for any other
  reaction, `REACTIONS_CLOSED` where the viewer may not react, and
  `LIKE_TARGET_UNREAD` where the two say different things. Else it makes ONE
  POST of a LIKE to the post's thread, never repeated: LinkedIn's stated
  refusal is `LIKE_REFUSED` with its words, and created nothing. A 2xx is
  LinkedIn's own success — the reaction API answers with an empty body — and
  settles `liked` with its status for the receipt. Only an answer that settles
  nothing (a timeout, a 5xx, none) is read back: the post opened afresh and
  its data showing the Like, `LIKE_UNCONFIRMED` otherwise. A like that landed is liked again as
  `already_liked`, nothing sent. `read_like_state` reads the document without
  sending anything, and is what settles an uncertain like. It names the account
  that was signed in (`accountId`, a `/me` probe that does not leave the post),
  which the caller compares with the account it expects before any read — a
  `Default` included — settles a like.
- `like_comment` (added 2026-08-03) likes ONE comment under its parent post —
  the incoming-dismissal acknowledgement, and since Phase 48 the Ambassador's
  Like reply, through the action ledger — on `like_post`'s contract. It opens
  the PARENT post at the comment by LinkedIn's own link to it — a reply's,
  `?commentUrn=<comment>&replyUrn=<reply>` (`like_data.reply_link_query`),
  where the comment it answers is named (`parentCommentUrn`), else the
  comment's own `?commentUrn=` — and reads the comment's reaction from that
  document and LinkedIn's comment data together: a reply's among the replies
  under the comment it answers, a comment's among the post's comments (the
  comment's own `SocialActivityCounts`). The LIKE goes to the comment's urn as
  that data lists it, refused unless it is on this post (`THREAD_MISMATCH`); a
  comment neither source shows is `LIKE_TARGET_UNREAD`, nothing sent. Either
  source showing the Like is a Like; `Default` is only what a source says and
  none contradicts; two reactions that differ, or nothing said, is null — never
  "not liked". Whatever refuses before the POST, and LinkedIn's refusal of it,
  carries `notAttempted` on the wire (the like is not there); a POST whose
  outcome is unknown never does. One line per attempt (`like_attempt.py`),
  `[like] <post|comment|reply> sent=<yes|no> result=<…>`, is left in the log,
  with no name, word or id.
- `fetch_own_posts` reads `recent-activity/all/` from LinkedIn's JSON and keeps
  only posts the account authored: a reshare is dropped whole (a repost with a
  comment included, since the row's text cannot be proved the owner's), and so
  is a company page's post or any row whose author did not resolve to this
  member. It pages on until `limit` such posts or the end of the feed. Where
  the JSON does not answer there is no DOM fallback (`UI_DRIFT`): the markup
  cannot tell a repost from a post.
- `fetch_own_comments` reads the account's comments activity page from LinkedIn's
  own data (`own_comments.py`), never its markup: the first screen from the
  document the page is served as, then at most `OWN_COMMENT_PAGES` pages in all.
  Each further page is the response to the request LinkedIn's own pager makes
  when the page's scroller (`<main>`) is scrolled to its end, with CDP focus
  emulation on for the scroll (a hidden or covered window does not run the
  pager otherwise) and off after it. Where the pager still does not run within
  `OWN_COMMENTS_SCROLL_WAIT_S`, the request the document declared
  (`nextPageRequest`) is made once from the page itself (`OWN_COMMENTS_PAGE_JS`),
  carrying the headers the page's own client sent on its earlier `rsc-action`
  requests (`RscPageHeaders`) and the CSRF token from the session cookie; with
  no page instance and track named, it is not made. A pager that has sent its
  request is waited for, never answered by a second one. A page over
  `OWN_COMMENT_PAGE_BYTES` is refused, and the pages share
  `OWN_COMMENTS_PAGING_BUDGET_S`, past which the read returns what it has. If
  focus emulation cannot be confirmed off, the tab is closed and the read ends
  incomplete. The scroll is not tried again in that read. Nothing is pressed or
  typed. A page must be the one
  that follows the one before it, and a page that does not follow, belongs to
  another profile or does not parse fails the read (`UI_DRIFT`). A page that is
  not THERE (refused, never answered, body lost) after at least one comment was
  read returns those comments with `incomplete: true`; with none read it fails
  (`UI_DRIFT`, or `BROWSER_TRANSIENT` when asking again may do). The list ends
  where a page declares no next request. Only comments the page marks the
  account's own count. The client allows this read longer than the default
  (`OWN_COMMENTS_TIMEOUT_MS`).
- `read_post_thread` and `read_author_profile` (added 2026-10-09) are the
  verify stage's reads, read-only and outside the write capability. Each
  navigates to the page a person would open — the post, the member's profile —
  then reads that page's JSON: the post with up to 50 of its most relevant
  comments (who wrote each, whether the post's author answered under it,
  whether the connected account wrote it), or the member with their five latest
  posts. A profile visit can show on that member's list of who viewed their
  profile; a company identifier is answered without one. Neither falls back to
  the DOM: a read that will not answer is `THREAD_UNAVAILABLE` /
  `PROFILE_UNAVAILABLE`, because a scraped `isOwner` or author reply would
  verify a post on facts that are not there. The comments response shape is
  UNVERIFIED against a live capture — `scripts/local/voyager-capture.py` with
  `CAPTURE_POST_ACTIVITY` set records one.
- `read_author_profile` with `role` (added 2026-11-17) also reads the member's
  current role. The profile lookup carries no positions and the profile page
  draws its Experience card only for a reader who scrolls to it, so the role
  is read off the member's experience page (`/in/<slug>/details/experience/`):
  the first entry still running, its title, company and the company page it
  links, by that page's numeric id (`experience.py`). An entry that links no
  page takes one the member's activity links under the same name, or none.
  Seen live on 2026-11-17; a page that does not load costs the role alone.
- `read_company_page` (added 2026-10-26) is Deep's read of a lead's company,
  read-only and outside the write capability. It takes the `companyRef` a
  profile read's current role linked (`currentRole.companyRef`: the page's
  public identifier, its numeric id, or its `/company/<slug>/` address), navigates to that
  company's page — the visit a person makes — and reads the page's
  organization JSON (`organization/companies?q=universalName`): its name, size
  band, first industry, About and followers, each bounded, and nothing else —
  no people, no email. Nothing on the page is pressed or followed. A page that
  is not there, or answers for another company, is `COMPANY_UNAVAILABLE`. The
  profile read keeps that link only where its lookup carries a current position
  naming a company entity. Both shapes are UNVERIFIED against a live capture.
- `read_comment_replies` (added 2026-10-11) reads the replies directly under
  one of our comments, read-only and outside the write capability. It asks
  LinkedIn's own comment data for that comment's thread first
  (`comment_data.py`, 2026-10-13): one in-page GET per fifty replies, from
  whatever LinkedIn page is open, the urn exactly as given; every reply whose
  `parentCommentUrn` is ours, with its whole words, time and author, and
  `repliesFrom: "comment_data"`. It answers where the post's page has ranked
  our comment out of view, and names no author for our comment
  (`authorIsSelf: null`). A refusal or a shape it does not recognise falls
  back to the page read. That read opens
  the parent post, pages in top-level comments until our row renders, presses
  the replies control under OUR row only, then serialises the page's markup and
  reads it in Python (`replies.py`): every rule runs against the saved pages in
  `tests/fixtures/replies/`, and none reads layout, because the window is
  hidden. Our row is matched by its comment id in either inner spelling; a
  reply counts only when its nearest keyed row is ours; a structure the reader
  does not recognise is `UI_DRIFT`, carrying the page's shape fingerprint and a
  redacted excerpt; a read that cannot finish loading is `THREAD_INCOMPLETE`;
  and our comment absent from a fully loaded thread on the post's own page is
  `present: false` — which says only that the page did not show it. A page
  that is not the post is `THREAD_UNAVAILABLE`, worth a retry, save one:
  LinkedIn's own page for a post deleted or removed — the post's address, no
  post on it, and "Post not found" over "This post was deleted or removed"
  (read live 2026-10-19; `post_deleted.html` is synthetic) — which is not
  retryable, and is what the agent reader's load of the post answers too. Beside
  the replies it reports the count LinkedIn shows
  (`replyCount`, null when none) and the rows it recognised (`replyRows`):
  replies in a shape it does not know read as no rows at all, so a reply
  missing from a read proves a deletion only where the two agree. The
  redesign's reply nesting is RECONSTRUCTED from the
  2026-10-08 notes, not captured: UNVERIFIED until the owner-authorized live
  read.
- `read_relationship` (added 2026-10-11, read from data 2026-10-14) reads
  where the connected account stands with one member, read-only and outside
  the write capability. It takes `profileId` or `profileUrl` (a member's
  public identifier, the id in their profile urn, or their `/in/` URL; a
  company page is refused before any navigation), opens the member's own
  profile — a visit that can show on their list of who viewed their profile —
  and keeps the document the page is served as: the redesigned profile is
  server-driven, and its data arrives as React flight rows in that document's
  `#rehydrate-data` script, gone from the page once it renders. Python reads
  them (`profile_data.py`, over the parser `thread_data.py` uses for posts)
  against the synthetic documents in `tests/fixtures/profile_data/`, by
  LinkedIn's own keys only: the top card
  `com.linkedin.sdui.profile.card.ref<P>Topcard`, a `{vanityName, profileId}`
  payload binding the identifier to `<P>`, the PROFILE_VIEW breadcrumb's
  `vieweeMemberUrn`, and the model states `profile_network_distance_<P>` (the
  degree) and `state:invitation:urn:li:member:<N>` (`Connect`, `Pending` or
  `Withdrawn`). `profile.verified` is true only when all three bind; the
  result adds `profileUrn`, `memberId`, `invitation` and `connect` — the
  composer the member's own Connect navigates to, `instant` where it sends at
  once and `other` where it does anything else (neither ever pressed), or
  `none`. No heading, class or label decides a fact,
  and nothing is pressed, More included. Two top cards, the identifier bound
  to another member, two degrees or an invitation switch beside a connection
  is `UI_DRIFT`; an unknown value is `unknown`; the profile's data never says
  `incoming`. A landing off a member's page (`/404/`, `/in/unavailable/`) is
  `PROFILE_UNAVAILABLE`, not retryable; a document the browser did not keep,
  or one holding no rows, is `PROFILE_UNAVAILABLE` and retryable. Each read
  carries `sessionId`, minted each time the browser starts, which is what
  "read in the same session" compares. The note (`supported`, `limitChars`)
  is LinkedIn's compose view's, so a read's is `unknown`. Verified against the
  owner's own profile and a 1st-degree connection's documents and a live
  3rd-degree `Connect` (2026-10-14); `Distance2`/`Distance3` and the top
  card's `Pending`/`Withdrawn` are PARTLY VERIFIED until the first read of
  such a member. Since 2026-10-20 where the account stands with the member —
  `degree`, `pending`, `invitation` — is LinkedIn's relationship data for
  them, fetched from the page the read loaded: the GET LinkedIn's client
  makes for the top card, `identity/dash/profiles?q=memberIdentity` decorated
  `com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-30` (its
  recipe map's name, read from the bundle), whose `MemberRelationship` states
  `connection`, `self` or `noConnection` — `memberDistance` (`DISTANCE_2`,
  `DISTANCE_3`, `OUT_OF_NETWORK`) and `noInvitation` or an `invitation`
  `SENT`/`RECEIVED`, `PENDING`/`WITHDRAWN` (`member_relationship.py`). A
  member whose card leads with Follow declares no
  `profile_network_distance_<P>` in the document, so every such read was
  `unknown` before; LinkedIn's data states their degree. Who the member is
  stays the document's binding, and the data must name the same profile urn
  and member number, or the read is `UI_DRIFT`; the data now says `incoming`
  too. Where the GET fails or answers in a shape the parser does not read,
  the document's facts stand. Read live 2026-10-20 for a 3rd-degree member
  with nothing pending and for a connection; the invitation branches are the
  bundle's: PARTLY VERIFIED. `place: true` (added 2026-10-19) also asks where the member
  is: the document's rows carry no location, so on a read that bound the
  member it makes the profile lookup `read_author_profile` makes
  (`identity/dash/profiles?q=memberIdentity`) from the page already open — no
  second visit — and answers `place` with the location's `country` and
  `geoUrn`, `{}` where it names neither, and nothing where the lookup failed
  or named another profile urn. The invitation preflight asks for it where
  the Audience names countries and no recent read placed the person.
- `read_incoming_invitations` (added 2026-10-11; from data 2026-10-14) reads
  the invitations people sent the connected account, read-only and outside the
  write capability. It takes `limit` (1–100) and an optional `since`, opens the
  account's own received-invitations page — nobody sees the account read its
  own list — keeping the document LinkedIn serves for it, and reads that
  document's own data (`#rehydrate-data` flight rows) in Python
  (`invitations_data.py`). A request is a row keyed
  `invitation_manager_row_urn:li:invitation:<id>`; its type, id and member come
  from the `addaInvitationAction` requests its buttons carry, its state from
  the model state `invitation_action_state_<id>` the page starts from, its
  sender's slug from the page's own `{vanityName, vieweeProfileId}` binding,
  and their name from the Accept's own label. Only a `CONNECTION` still
  `Pending` is listed; a `MEMBER_FOLLOW` or `ORGANIZATION` one is counted in
  `others`. The data dates no invitation and carries no note, so `since`
  leaves none out and neither is returned. `complete` is true only where the
  rows keyed number the page's own `invitationManagerReceivedRegularCount` and
  `invitationManagerReceivedHasSpam` is `No`; `Yes` is the "other inbox"
  banner, `otherInbox`. A request bound to no single public profile, two from
  one sender, an action naming no request, a type or state it does not know,
  or data showing neither a request nor the list's count is `UI_DRIFT`; a
  document not kept, or carrying no data, is `INVITATIONS_UNAVAILABLE`
  (retryable) — never "no invitations". The rules run over synthetic documents
  built in the shape of the page captured 2026-10-14.
- The member writes below — an acceptance, an invitation, a withdrawal, a DM
  and a first message — are one request each, `step: send | resolve`. Where an
  entry says `prepare` and `commit`, they are the two halves of that one
  `send`: the first reads and binds, pressing nothing and journaling nothing;
  the second probes the account once more, journals `CLICKING` — the attempt's
  first journal write, so a refusal or a crash before it sent nothing — and
  presses once. There is no one-time token and no `PREPARED` entry (a
  version-1 journal's are dropped on upgrade, as nothing was sent under them),
  and no capability flag: the live-writes switch is the one gate.
- `accept_invitation` (added 2026-10-11, as `send_invitation`) accepts one invitation —
  `invitationId` (its `urn:li:invitation:<id>`), `senderProfileId`,
  `operationId` and their `fingerprint` — behind the same
  live-writes switch as a comment (`resolve` only reads), on the same journal. `prepare` reads the invitations page's data
  afresh (`invitations_data.py`) and refuses (`invitation_not_listed`) unless
  it lists exactly that request from that sender — a person's, Pending, so a
  follow's or a page's never is; then it binds the one control whose label
  starts "Accept" inside the row keyed
  `invitation_manager_row_urn:li:invitation:<id>` and tags it, pressing
  nothing (`invitation_accept.py`). `commit` probes the account
  before it journals `CLICKING` — a failed probe pressed nothing —
  then presses the tagged Accept once, waits for the row's Accept to leave
  the page, and answers from the sender's profile read in the same session
  until it shows `1st` (`PROFILE_RECEIPT_READS`): `1st` is `confirmed`.
  Otherwise the page's data is read too, and anything else is `uncertain` — a
  profile offering Connect right after the press may simply not have caught
  up, so only a later `resolve` calls a request gone
  from a whole list with Connect on offer `blocked` (`invitation_withdrawn`).
  `resolve` reads the same way, told by `reads` (0, 1 or 2) how many page
  loads the caller has budgeted: the journal alone answers an attempt that
  never reached its press (`resolved_not_sent`) and a settled one; for any
  other with no page budgeted it answers `read_needed` and loads nothing; one
  page reads the sender's profile alone. It answers `still_pending`, with
  `observedAt` (when the data was read), for a request still listed, for the
  caller to weigh against the time since the press. A later call under the
  same operation id never presses again. That the press accepts with no
  confirmation step is UNVERIFIED until the first real acceptance.
- `read_inbox` (added 2026-10-11) reads the account's conversations as the
  messaging inbox lists them, outside the write capability: it writes nothing
  but the unread marks its own presses took (below). It takes `limit` (1–50) and an optional `since`, opens `/messaging/`, re-reads
  `main`'s markup until the conversation list holds a card (an empty inbox is
  believed only after the whole wait), and reads it in Python (`messaging.py`)
  against the saved pages in `tests/fixtures/messaging/`. Nothing is scrolled,
  so the conversations are the ones LinkedIn renders on arrival, newest first.
  Since 2026-10-12 the live cards link no conversation: a card opens its
  thread through a click handler, and the id is in the address bar once it
  has. A card that links none is learnt by pressing its one
  `.msg-conversation-listitem__link`, found by the card's own `id`, and
  accepting the address only once the list marks that card, and no other,
  active (`.msg-conversation-listitem__active-text`) on a thread's address
  that moved off where it was — or stayed, for the card already open — read
  the same twice running (3s at most a card). Only cards the read returns are
  pressed, after `since` and `limit` have been settled, 3–7s apart; a card
  that links its thread (the legacy shape) is never pressed. A press that
  does not land is `UI_DRIFT`. Before every press, a message composer
  anywhere on the page — beside the list or in the overlay — that has focus
  or holds words stops the read with `COMPOSER_IN_USE`, nothing pressed.
  Opening a card that shows unread marks it seen: LinkedIn sends its read
  receipt, which nothing recalls. Once the page has moved off it (a card that
  showed nothing unread is pressed for that where it was the last), the read
  opens the card's own overflow menu (`button.msg-thread-actions__control`)
  and presses the one item whose accessible label is exactly "Mark as
  unread" — the menu sits beside Archive, Delete and Report, and nothing else
  in it is pressed — then re-reads the card for its unread mark. A menu with
  no such item, or more than one, is closed with Escape. The thread carries
  `markedSeen` and `unreadRestore`: `restored`, or
  `unread_restore_unconfirmed`, never pressed again. A read that fails after
  opening cards still restores them before it reports the failure. The
  driver gives the read 480s. Each card gives its thread id, the people it names — an id
  beside a name only where the card links that member's `/in/` page under it,
  never one guessed from a name — whether it is a group's, whether it is
  unread, and its last message as a hash, `fromSelf` read off the snippet's own
  sender element (never its words) and `at` only from a `datetime` attribute,
  never from "8:51 AM" or "Yesterday". `since` drops a card whose `datetime`
  is older, or, without one, whose visible day ("Oct 3", "Oct 3, 2025", a
  weekday) ends before it in every timezone; a time of day or "Yesterday"
  drops nothing. `truncated` says `limit` cut the list. A list item that is
  not a card, a card linking two threads or neither linking one nor
  pressable, one thread on two cards, a card naming no one, or a member
  linked and not named is `UI_DRIFT`.
- `read_dm_thread` (added 2026-10-11) reads one conversation, read-only and
  outside the write capability. It takes `threadId` (refused before any
  navigation unless it is one LinkedIn mints) and an optional `since`, opens
  `/messaging/thread/<id>/`, re-reads its markup until the thread's header, a
  message and its composer render, and reads it in Python (`messaging.py`). A
  landing anywhere but that thread — LinkedIn sends one that is gone, or not
  this account's, to the inbox — is `THREAD_UNAVAILABLE`, not retryable, before
  any wait. It reports every participant, the account included, from the
  header's member links and the messages' authors — a member the page links by
  member id (`/in/ACoAA…`, as the live page links everyone) by their member urn
  and no profile id, their messages by that urn, and the account by its own
  urn as by its profile; the messages oldest first,
  each with its author from the group meta above it (consecutive messages carry
  none and inherit it), its text and hash, and `sentAt` only from a `datetime`
  attribute; `complete`, true only where the read reached a message older than
  `since` or the card that heads the conversation's first message, with no
  loader above it — a list that merely shows no loader proves nothing; and the
  composer. Nothing is pressed, typed, focused or scrolled: a draft waiting in
  the composer is someone's unsent words, read off the markup and never
  touched, and only its hash is returned. Opening a conversation does what it
  does for a person, though: LinkedIn marks it seen, so a message the owner had
  not read loses its unread mark — which is why the product opens one only
  when its card shows something new from a campaign's person.
  A header that links no member, a message before any group names its author,
  an author a two-person thread has no place for, a message without an id or
  with another's, and a composer missing or doubled are `UI_DRIFT`. Both reads
  serialise `main` only, never the body, whose messaging overlay holds other
  threads' composers. The messaging markup is RECONSTRUCTED from the legacy
  layout, not captured — a capture of a real inbox is real people's messages:
  UNVERIFIED until the owner-authorized live read.
- `send_invitation` (added 2026-10-11; one POST since 2026-10-20) sends one
  member an invitation with a note, on the comment's write journal, in three
  sub-steps under one `operationId`, each naming the member, the note and
  their `fingerprint` (`input_fingerprint` of `{kind: "invitation",
  profileId, note}`, which the sidecar recomputes and binds). It is sent as
  LinkedIn's own client sends it (`invitation-platform`'s
  `verifyQuotaAndCreateDashRequestV2`, read from its bundle 2026-10-20): one
  in-page POST to
  `/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-3`
  of `{"invitee":{"inviteeUnion":{"memberProfile":"<profile urn>"}},"customMessage":"<the note>"}`,
  with the CSRF token from `JSESSIONID`; nothing is typed or pressed, and no
  composer is opened (`invitation_write.py`). Like LinkedIn's own client, it
  writes from the page a person would be on (`page_visit.py`,
  `BrowserUseBackend._on_page`): the member's profile is opened as any page
  view is before anything is asked, every GET and the POST are made from it
  (the tab is kept there, or opened on it again where it has left before
  the POST), and the POST carries the headers that page's own client names it
  by — `x-li-page-instance`, `x-li-track`, `x-li-lang` — read off the
  browser's network events from the API requests its client made for the
  page (the preload shell's own are not the page's), never made up. `prepare` re-reads the member's
  own profile — LinkedIn's relationship data for them, as `read_relationship`
  reads it — and refuses, as `refused`, nothing sent, unless it shows the
  member `expected` names (their profile urn and member number, else
  `profile_unverified`), 2nd or 3rd degree as it says (else
  `relationship_moved`), with Connect on offer: connected
  `already_connected`, pending either way `invitation_pending` /
  `invitation_incoming`, withdrawn `recently_withdrawn` (LinkedIn takes none
  for three weeks), LinkedIn asking for their email `invitation_gated`,
  anything the data does not state `relationship_unknown`. It reads LinkedIn's
  compose view for the account's notes (the GraphQL query
  `voyagerRelationshipsDashCustomInviteComposeView`, the client's note box's)
  and refuses a note longer than its `maxMessageLength` (`note_limit`), a view
  that names none (`note_limit_unread`) and an account with no note left
  (`note_unavailable`). It holds the path and the body
  the POST will send; a GET that does not answer is
  `PROFILE_UNAVAILABLE`, retryable, before anything is journaled. `commit`
  re-validates the page — still the member's profile, the
  same browser session, the session cookie — probes the account once more —
  a probe that cannot answer or names another account is an error before
  anything is sent, with nothing journaled — journals `CLICKING`, and
  makes the one POST: a 2xx naming the invitation it created
  (`invitationUrn`, `urn:li:fsd_invitation:<id>`) is `confirmed` with a
  receipt (`invitationUrn`, `invitationId`, `sentAt` — when the answer came
  back — `noteHash`, `sessionId`, the answer's shape fingerprint), beside the
  member read again until it shows the invitation pending, which the conversation
  records — or none, where no read did, and the receipt stands; a 4xx is
  `blocked` with LinkedIn's code and words (the weekly limit is a 429 its
  client reads as `FUSE_LIMIT_EXCEEDED`, and is a refusal too); a timeout
  (20s), a network error, a 5xx, a 408/409/425 or any other 429, or a 2xx
  naming no invitation is `uncertain`, with what was seen. Nothing under an
  id that reached `CLICKING` is ever sent again. `resolve` reads the member
  against the journal: pending, withdrawn since or connected is `confirmed`;
  only Connect on offer and nothing pending — LinkedIn's data stating no
  invitation — is `resolved_not_sent`, and only on a read a quarter hour
  after the POST (`ABSENCE_SETTLE_MS`): an earlier one leaves the attempt
  `uncertain` for the look that reads again. A read that binds nothing stays
  `uncertain`; an id that never reached its POST is closed
  `resolved_not_sent` without a read. `resolve` only reads. LinkedIn's answer to the
  POST is the client's reader's shape and its refusals the restli error the
  client reads: UNVERIFIED until the owner's first invitation on this build.
- `withdraw_invitation` (added 2026-10-14) withdraws one invitation of ours
  still pending, on the same write journal, in three sub-steps under one
  `operationId`, each naming the member and their `fingerprint`
  (`input_fingerprint` of `{kind: "withdrawal", profileId}`). `prepare`
  re-reads the member's own profile and refuses — as `refused`, nothing
  pressed — unless its data shows them verified, with the member number
  their Pending is keyed by, and their invitation switch on Pending (not
  connected `already_connected`, Connect or Withdrawn `invitation_not_pending`,
  theirs instead `invitation_incoming`); binds the one control the page
  renders under the key that data names for it,
  `ConnectButtonstate:invitation:urn:li:member:<N>_pending`, anywhere in the
  document — the top card, or a dropdown LinkedIn portals beside `main` —
  pressing the top card's own More once, which opens a menu and sends
  nothing, only where nothing renders under the key yet (nothing ever, or two
  controls under it, is `UI_DRIFT`, never "not pending"); tags it and checks
  over the page read again that the tag sits on exactly that control;
  It presses nothing that
  withdraws. `commit` re-validates the tagged control,
  probes the account once more as an invitation's commit does, journals
  `CLICKING`, and only then presses Pending — on a layout this module does
  not know it might withdraw at once — and LinkedIn's confirmation's own Withdraw,
  once each, never its Cancel: LinkedIn's printed refusal is `blocked`, a
  confirmation still open is `uncertain`, and everything else — the
  confirmation gone, never opened, or its Withdraw not pressable — is answered
  by the member's profile read in this session until it shows it: the member the
  admitting read bound, their switch on Withdrawn or back on Connect, is
  `confirmed`, connected is `blocked` (`already_connected`), anything else
  `uncertain`. Nothing under an id that reached `CLICKING` is ever pressed
  again. `resolve` reads the member against the journal: Withdrawn or
  Connect is `confirmed`, connected `blocked`, still Pending `still_pending`
  with the attempt left open — whether that read is long enough after the press to
  say nothing was withdrawn is the caller's call — and an id that never
  reached its press is closed `resolved_not_sent` without a read. `resolve` only reads. The
  rules run over saved pages in `tests/fixtures/withdraw/`; the keyed control,
  the More and the confirmation are RECONSTRUCTED: UNVERIFIED until the first
  real withdrawal.
- `send_dm` (added 2026-10-11) sends one message into one conversation, on the
  same write journal, in three sub-steps under one `operationId`, each naming
  the conversation (`threadId`), the recipient's profile id
  (`recipientProfileId`), the words (`text`, at most 8,000 characters) and
  their `fingerprint` (`input_fingerprint` of `{kind: "dm", threadId,
  recipientProfileId, text}`). Since 2026-10-20 a DM is sent as LinkedIn's own
  messaging client sends it — one POST to
  `/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage`
  from the conversation's own page, opened (or kept) just before the journal
  holds `CLICKING`, with the headers that page's own client names it by
  (`page_visit.py`) and its CSRF token —
  and no composer is typed into or Send pressed. The body is the client's
  `sendMessageToConversationAPI` request, read from its bundle:
  `{message: {body: {text, attributes: []}, conversationUrn, originToken},
  mailboxUrn, trackingId, dedupeByClientGeneratedToken: true}`, the words
  exactly the owner's, `originToken` a UUID derived from the `operationId`
  (every attempt under one id carries the same one) and `trackingId` its
  sixteen bytes, as the client derives it. `prepare` loads the conversation
  list as the compose view's own load fetches it — the mailbox its request
  names — and reads the conversation's history without opening it (its page,
  loaded afresh, where the list does not name it or its history cannot
  answer), and refuses, as `refused` with nothing sent, a conversation
  LinkedIn will not carry a message in (`messaging_restricted`, in its own
  words), a group (`group_thread`), one whose other person is not the
  recipient — by `expected.memberUrn`, the member urn the conversation is bound
  to, where the caller names one, else by profile id
  (`participants_mismatch`) — one whose newest message is no longer
  `expected.lastMessageId` (`thread_moved`), and, where the read was the
  conversation's page — the one read that shows its composer — one whose
  composer holds words that are not these (`human_draft`: someone is writing
  there; nothing touches it). It holds the conversation's urn in that mailbox and the
  `originToken`; nothing is written. `commit` probes the account and re-validates the page — still LinkedIn's messaging, in the same
  browser session, holding its session cookie, else `PREPARED_UI_STALE` with
  what changed — before it journals `CLICKING`, then makes the one POST.
  LinkedIn's answer naming the message it created in the mailbox, in this
  conversation, with these words and this token is `confirmed`, carrying its
  urn, its delivery time as `sentAt`, and the answer's shape fingerprint; a
  4xx is LinkedIn's refusal, `blocked` (`refused_after_send`) with its status
  and its own words; anything else — no answer, a 20-second timeout, a 5xx,
  408/409/425/429, an answer this module cannot read — is `uncertain`, with
  what was seen, and is never posted again. `resolve` reads the conversation
  against the journal: its history, read afresh in this session and opening
  nothing (its page, which acknowledges delivery, only where the history
  cannot answer; an optional `members` names whose profile each member urn in
  it is, as the caller's reads tied them): our message after
  `expected.lastMessageId` with exactly these words' hash is `confirmed`; an
  attempt that never reached `CLICKING` is `resolved_not_sent`; otherwise
  `uncertain`, with `absent` true only where the read was the history and its
  newest message is still the one the DM was written after — a page read
  that did not show the message never says so, the words still in the
  composer included (client state LinkedIn restores as a draft). `resolve` only reads.
  `dm_write.py` holds the rules; LinkedIn's answer to the POST is read in the
  shape its client reads it (`messagePostToState`): UNVERIFIED until the
  owner's first send on this build.
- `open_dm` (added 2026-10-15) sends the first message to a connection, into
  no conversation yet, on the same journal and sub-steps as `send_dm`, each
  naming the member (`recipientProfileId`), the words and their `fingerprint`
  (`input_fingerprint` of `{kind: "open_dm", recipientProfileId, text}`).
  `prepare` reads the member's profile data in this session — refusing
  `not_connected` unless `Distance1`, and `message_unavailable` unless their
  Message trigger (`messageActor`) leads to the compose view for exactly their
  profile urn and, as `recipient`, the same member (`recipient_unbound`
  otherwise) — then the account's conversation list (`conversation_exists` for
  any 1:1 with them), then opens that compose view at LinkedIn's own link,
  never a button, and refuses `recipient_unbound` unless its own load names
  exactly them, and no one else, as the recipient — the compose context
  (`recipients:List(<profile urn>)`) or the compose option for them — and the
  address it stays on does not contradict it; `messaging_restricted` where
  that context blocks the message or the option is a paid InMail; and
  `conversation_exists` where the view left compose or its own lookup of
  their conversations lists one. Where the account's list is only its first
  page, no 1:1 on it rules none out: the view's own lookup of their
  conversations must list none (`conversation_unverified` otherwise). It
  types nothing. `commit` makes the one POST as `send_dm` does, from the
  member's own profile, where their Message is, to them alone — the client's `sendFirstMessageToRecipientsAPI`
  body, `hostRecipientUrns: [<profile urn>]` in place of a `conversationUrn` —
  and is `confirmed` only where LinkedIn's answer names the message it created
  and the conversation it opened, whose history, read without opening it, is
  a 1:1 with them showing these words since the press; that conversation is
  carried for the caller to bind. A created message whose conversation does
  not read back so is `uncertain`, naming the message. `resolve` reads the
  account's list afresh; `absent` is a list whole since the press with no
  conversation with them. `dm_open.py` holds the rules, read from the capture
  of 2026-10-15 of the compose view opened by LinkedIn's own link.
- v1 writes comments, replies, both likes, an acceptance, an invitation with a
  note, a DM in a conversation the product has bound and the first message to
  a connection; engagement polling is out of scope.
- Search and activity pages are rendered-UI integrations. Their selectors and
  URL parameters are versioned by `linkedin-2026-10-14.1` and must be verified
  in the supervised live spike before production use.
- Author discovery accepts a LinkedIn `/in/` URL or public slug. Provider-only
  member URNs cannot be deterministically resolved through the public UI.
- Chromium is driven over CDP by `chromium.py` alone; the Engager protocol and
  fake backend keep the TypeScript driver independent of it.
- LinkedIn promises no response IDs. A write is confirmed only
  when the rendered DOM contains the exact normalized text, the connected
  account's canonical profile URL, and a canonical comment URN.
