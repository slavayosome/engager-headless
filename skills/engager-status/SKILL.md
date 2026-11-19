---
name: engager-status
version: 0.0.98
description: Report how the local Engager stack is doing, change the account's limits or stop it when the owner asks, and dig from a campaign to a run to one item to answer why something happened. One `get_status` call gathers the health report, with `get_channel` and `list_campaigns` beside it. Use for "how's Engager doing", "status report", "why was this withheld / dropped / not sent", "why so few comments", "what goes out today", "slow it down", "stop everything", "why didn't it run", or before changing any configuration.
---

# Engager Status — health, the account's limits and stops, and the drill-down

The account is real and LinkedIn offers no compliant automation API: low caps,
the paced day plan and the stops reduce the exposure of unattended work; they
do not remove it. This skill reads, explains and, on the owner's exact ask,
changes a limit or throws a stop. It never loosens one on its own reading, and
never flips live sending on: that switch is the owner's, in Engager.

Report numbers read in THIS session. Every counter is a row the server wrote,
never a figure a model reported. A scary early finding (a stop thrown, a dead
agent, a skipped run) is a finding to report, not a reason to stop or to fix
inline.

Say every time on the owner's clock. Each moment a read returns has a
`…Local` twin beside it, and `get_status` names the `timezone`. Never say UTC;
when `timezone` is null, say the time relative to now ("in about 3 hours").

## The health report

"How's Engager doing" gathers everything with three reads and no write:

1. `get_status include [setup, health, jobs]`: the setup checklist, the agent,
   the kill switch, auto-pause, connection, operations and jobs.
2. `get_channel` (default connection, limits, policy, own-post replies, live
   checks): the account and its budget.
3. `list_campaigns`: every campaign and its status.

Add to that `get_status include` only for what is asked: `usage` (reported
tokens; unknown stays unknown), `models`,
`learning`, `billing`, `queue`.

Durable Stops need a separate `list_activity view: waiting` read and its
`stops` collection. Say so when reporting them; the three reads do not expose
that collection.

Lead with the top-line findings, in this order, each stated ABOVE the rest:

- A **stop**: the kill switch or an auto-pause (`pausedReason`, `pausedUntil`)
  or a durable Stop. Say which; neither is yours to clear unasked.
- **Not connected** (`needs_signin`: nothing reaches LinkedIn until the owner
  signs in). `not_configured` before the first sign-in is normal.
- **The agent**: not installed, or an `error`: background inference is
  unavailable. Quote the error verbatim; setup owns the fix (engager-setup).
  A role whose model is not offered runs the newest of its family: one line.
- **Dead or failing jobs** in `jobs`, a `worker_run` failure belonging to its
  campaign.
- **No tick** while a campaign is Active: nothing wakes, and the fix is a
  process (the Engager app, or `engager up`), not a setting. With every
  campaign Paused it is the expected reading.

Then a one-line verdict, then plain sentences per area: the account, each
campaign (status, whether the owner has started it, last run, what waits on
them), knowledge, the agent. Open tasks and owed tasks are judgments waiting on
whoever is reading: report the count, and offer to settle them (`get_task`,
`finish_task`). A setup checklist item about the setup skill not being loaded
describes your session, not the account; any other unfinished item routes to
engager-setup. If `skills` reads `outdated`, re-read this skill once with
`get_skill_file`; never loop.

Knowledge: Brain coverage is a word per slot, never a percentage; a thin
voice sample count means the owner has not written much yet. Both route to
engager-voice-and-brain.

## The drill-down: campaign, run, item, person

Every layer answers "why", and you name which read the answer came from.

1. **Campaign.** `get_campaign id include [runs, stats, searches, strategy]`.
   `runs` lists each worker's runs; `searches` shows the pipeline: words to
   screen, people waiting on a profile read, people to judge, set aside, stale,
   and a `gate` of open, `waiting_for_screen` (many wait: nothing is broken) or
   `waiting_for_agent` (the agent is out of quota, signed out or not answering:
   a finding).
2. **Run.** `get_run runId include [phases, items, plans, judge, steps,
   tool_calls, reads, errors]`. Follow `nextCursor` for item pages. Scout rows
   are in `items`; Ambassador messages are in `output`. Plans and agent steps
   are capped at 100 and cannot be paged: report `plansTruncated` or
   `stepsTruncated` as incomplete evidence. A run that never
   started carries a `skipReason`; it IS the answer to "why didn't it run":
   - Not a fault, nothing to press: `nothing_needed`, `backlog`,
     `campaign_locked` (another run holds the account), `conversation_not_runnable`.
   - The owner's to lift: `campaign_stopped`, `kill_switch`,
     `organization_paused`, and a paused or archived campaign
     (`target_paused`: their Run now does not override it).
   - A connection fault: `channel_not_connected`, `connector_unsupported`
     (rebinding, not reconnecting; quote `error`).
   - `authority_elsewhere`: another install holds the account. Say which you
     cannot know; never press again.
   - `leads_off`: the plan has leads off.
   An `interrupted` run (a sleep or a quit) usually runs again. A closed
   window is not a skip reason. Item rows carry refs;
   `plans` and `judge` show each draft's plan and the judge's verdict on every
   plan item and the one rewrite a miss earns; `reads` shows today's reads.
   Counters: drafted short of demand is rejected and cap-refused to explain
   first, then the matches on hand.
3. **Item.** `list_activity view` (waiting, upcoming, sent, came_back,
   problems; filter `kind`, `campaignId`) or `refs [msg:… act:…]` for exact
   rows (supply a valid `view` even with `refs`). Each row's `why` is one of: waiting on a yes, a cap, the window, a
   stop, a first-send check, uncertain, failed, scheduled, sent, came back, and
   carries the `run` that wrote it and the `person`. A Stop is also listed in
   `stops`. The owner reads a campaign's runs, sends and what came back on its
   Activity tab, a run's own page one line down.
4. **Person.** `get_person ref include [conversation, events, signals]` for
   what was said, in order, and what Scout's screen decided and why
   (engager-people).

If no reason is stored, say so; never invent one. A draft withheld by the
judge usually missed a plan item: `plans`/`judge` names it. `preview_drafts`
replays it (engager-voice-and-brain) but spends model calls.

## The account's limits

Every number belongs to the ACCOUNT: one budget, one day plan, however many
campaigns act on it. There is no per-campaign cap. One rule decides what
binds a send:

> **Caps bind unattended work. A comment the owner wrote themselves is only
> spaced.**

Authorship, not approval: approving an agent draft unchanged leaves it
unattended. What binds the owner's own is the min gap, the per-person
anti-repeat caps and the stops; no daily cap, no window, no ramp. So "why so
few comments" for an owner who writes their own is how many they saved.

`get_channel include [limits]` returns the budget and `rate` (usage and
`caps.effectiveDailyComment`, what the comment lane will enforce today).
Warm-up is a ramp on the cap, never a fence: a smaller number, never "not
yet". Recommend waiting it out over raising the cap.

**Search limits.** Report `dailySearchPageCap` and `hourlySearchCap` with
`limits.searches`: used against each limit, when the next one frees up
(`freesAt`), and `source: "environment"` when an install override is set (it
beats the account's number). "Daily search limit reached" in a run note is that
budget spent, not a fault. Before raising either above 300 a day or 120 an
hour, tell the owner that is not recommended (more searches raise the chance
LinkedIn restricts the account); nothing refuses it. Reads (searches, thread and
profile reads, reply checks) are not sends and have their own caps; 0 means no
reads of that kind, not no limit.

**Why so few.** Find which phase starves, from the run: no leads (searches),
leads but no drafts (the run's rejected and cap-refused), drafts written but
posting slow (pacing: name the binding gate from `rate`). Drafting is not
posting; nothing posts while the Mac sleeps.

**The day plan.** `list_activity view: upcoming`: each row's slot and `why`.
Say whose each row is, owner's or unattended; clustered sessions and long gaps
on unattended rows are the human-day plan, intentional. The owner sees the same
queue, every campaign's, on the channel's Overview under Going out today, and
settles a send that holds the account there.

## Changing a limit: only on the exact ask

`update_channel limits`. Say the current number and the proposed one back in
plain words first, one notch at a time (20 to 25, never doubling). Lowering
reduces exposure and is cheap to offer to a nervous owner; raising on a fresh
or recently warned account is where restrictions come from: say that first.
Active hours match the audience's workday, not the owner's. Read the numbers
back; never present a raise as the fix for a shortage an earlier phase causes.
Volume down, cheapest first: pause the campaign, turn a step Off (a narrowing,
engager-campaigns), then a lower daily cap or narrower window. None un-approves
what is already scheduled; the kill switch alone does.

**Policy.** `get_channel include [policy]` shows the numbers and hours every
campaign on the account spends: each newer kind's daily number (`budgets`,
per 24 hours), the per-person DM cap, the sending windows (`schedule`), the
`version` and changes `waiting`. The account keeps no mode per action: a
step's mode is what happens, set in the campaign (engager-campaigns), and a
row's `needsNumber` says its Automatic stays Ask me until a number is set.
`update_channel policy` changes ONE thing per call, with `expectedVersion`, in
the owner's numbers; Automatic exists only on a number they set, which you
never pick or infer. To rein in the whole account: pause it, stop everything,
or set an action's daily number to 0. A
narrowing answers `applied`. A widening answers `proposed` and changes
nothing: tell the owner it waits for their confirmation in Engager, never that
it is done, and do not send it again.

**Own-post replies.** `update_channel ownPostReplies` (off, review, auto,
sensitivity gate, prompt) is the one mode the account keeps, because replies on
the owner's own posts belong to no campaign; it is not a ceiling over steps. The
owner sees it on the channel's Your posts tab. Raising the mode is the owner's, in Engager. Say
that `auto` posts replies nobody reads first.

## Stops

Two different things. The **kill switch** is the owner's global hard stop: while
on, nothing comments, replies or likes anywhere, and it is the one force that
undoes armed work. A **Stop** pauses the account, one campaign or one person's
conversation. Either: `stop scope kind on`, at once when asked. "Stop everything" is the
kill switch (`kind: kill_switch, scope: account, on: true`); "stop this
campaign" or "this person" is `kind: stop` on that scope. Confirm the kill
switch with `get_status`; confirm a scoped Stop with `list_activity view:
waiting` and its `stops` collection. Clearing re-arms nothing and
replays nothing; do it only when they ask, and only once the condition behind
an auto-pause is gone (`clearAutoPause`). Several campaigns the owner named
stop or resume in one call: `stop scope: campaign campaignIds kind: stop on`.
The blocklist and takeovers are engager-people.

## Rules

1. Change nothing unasked; confirm each change by reading it back.
2. Never claim the risk is gone.
3. Approve, Stop, resume, take over and release only on the owner's explicit
   ask for that exact thing.
4. Never press a campaign's Start or turn a step on from here
   (engager-campaigns).
