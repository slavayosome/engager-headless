---
name: engager-setup
version: 0.0.101
description: First-run path for a local Engager install. Check the stack, connect the Channel (the LinkedIn session in Engager's own browser), confirm which Agent thinks for Engager, seed the Brain and a provisional Voice from the owner's own posts, record one product or skip it, then hand off to engager-campaigns. Setup creates no campaign. Use for "set up Engager", "first run", "connect my LinkedIn", or when get_status shows setup unfinished.
---

# Engager Setup

You walk a new owner through the first run: the stack, the Channel, the Agent,
the Brain and Voice, one optional product. Then you hand them to
**engager-campaigns**, which owns every campaign. Setup creates no campaign,
changes no limit and starts nothing.

The account is a real LinkedIn account. LinkedIn offers no compliant API for
this work, so caps, the paced day plan and the kill switch reduce exposure
and nothing removes it. The Terms accepted at sign-up are the risk
record: never ask for another acknowledgement.

Tool calls go through Engager's MCP connection. With a shell,
`npx engager call <tool> '<json>'` reaches the same server.

## Start with one read

```
get_status {"include":["setup","health"],"loadedSkills":[{"name":"engager-setup","version":"0.0.100"}]}
```

The version in `loadedSkills` is this file's frontmatter version. Change one,
change both, or the server calls the skill outdated.

- `setup.checklist` is server state. Resume at the first open item and never
  redo a finished one. Disregard the legacy instructions in `setup.next`;
  follow this v2 workflow and seed the host's task list from the steps below.
- `setup.skills` says `outdated`: fetch `get_skill_file {"skill":"engager-setup","path":"SKILL.md"}`
  once and follow that copy. Never loop.
- `health.killSwitch` on: say so and stop.
- `setup.agent` and `health.connection` feed steps 2 and 3.

## 1. The stack (only if get_status cannot be reached)

Inside the Engager app, skip this. In an external client, the owner runs
`npm install -g engager && engager init` in their own terminal: it checks
prerequisites, writes the env file, migrates the database, creates the
organization, installs these skills and registers the MCP server. It asks for
no API keys. `engager doctor` diagnoses without changing anything. Then open a
fresh session and start again. See `sections/troubleshooting.md` when it fails.

## 2. Channel

Engager signs in through its own browser window. The owner types their
password there; you never see it.

1. `get_channel {"include":["connection"],"probe":true}`. A probe only reads.
2. Read `connection.status` and `probe`. If the status is `live`, report the
   account name shown, if any, and move on.
3. If the status is `needs_signin`, `not_configured` or `no_session`, ask the
   owner whether they want to sign in. On their yes, call `get_channel` with
   `probe: true`, `openSignIn: true` and `waitForSignInMs: 30000`. They sign
   in directly in the browser on their Mac. If they need more time, recheck
   with `recheck: true` in place of `openSignIn`. A probe error belongs in
   `sections/troubleshooting.md`.
4. Report a probe error or refusal as returned; use troubleshooting rather
   than inferring a stack failure from a missing connector field.

Signing in confirms the account. Only report posting availability from the
account's recorded settings and the campaign's modes. Never change write
authority during setup. **engager-status** explains the account's caps and pacing.

Gate: `live`, or the owner defers. If they defer, say plainly that nothing
can run until they sign in, and carry on.

## 3. Agent

`setup.agent` is the owner's AI CLI that thinks for Engager when nobody is
watching. Claude Code and Codex are supported; the others are coming soon.

- None selected is the ordinary first-run state, not a fault. You supply the
  judgment through tasks while you are here. Say once that background work
  starts after the owner chooses an agent in Engager (Settings, Your agent).
- An `error` there is real. Read it aloud, verbatim, then
  `sections/troubleshooting.md`. Never switch providers or API billing to
  repair a refusal. Agent selection is the owner's, in the app.

## 4. Brain and Voice

```
seed_brain {"source":"linkedin","scope":"both"}
```

Read each entry of `results` by `scope` and `mode` before you speak.

- `queued`: report that scope as pending on the background agent.
- `in_session`: complete that scope's prepared tasks. `get_task` with no id
  lists open tasks; read each task and finish its frozen items as directed.
  `unfrozen_item` writes nothing and returns the ids to copy.
- Error code `not_connected`: return to step 2.

Then go straight on; do not poll. Read the count once at the end with
`search_knowledge {"kind":"note"}`. Do not offer a fallback while a seed is
queued. If the completed seed yielded nothing, ask for a short background blurb and pass it verbatim as
`seed_brain {"source":"text","scope":"both","text":"…"}`, or point at their site
with `source: "url"`. Never invent Brain facts; store only what came from
their posts or their words, and show anything extra before saving.

The Voice is provisional. Every comment the owner writes themselves keeps
calibrating it, so there is no approval step. Reshaping it, extra voices and
deeper Brain filling belong to **engager-voice-and-brain**; never run an
interview here.

## 5. Product (optional, never a wall)

`list_products` first. With none, derive at most one likely product from the Brain
and the conversation and offer it once: a name and a one-line promise.

- The owner confirms: `save_product` once with what they confirmed. Nothing
  more here; facts and offers are **engager-voice-and-brain**'s.
- They have none or decline: `complete_setup {"step":"skip_product"}`.

## 6. Finish and hand off

```
complete_setup {"step":"done","loadedSkills":[{"name":"engager-setup","version":"0.0.100"}]}
```

Report only what the server read back. Say what was deferred: a Brain still
seeding, a skipped sign-in. A model summary is never evidence of a step.

`setup_campaign_required` means completion was refused and remains pending
until a campaign is active. Say so, hand off, and repeat the call once after
the owner's Start. Do not create a campaign here.

Hand off by naming **engager-campaigns**: it asks what to find, builds the
campaign from the catalog, tests it and stops at Start, which is the owner's
press in Engager. Offer to begin; load it only on a yes.

## Hard rules

- Show every write before making it. One question at a time.
- The owner's comment box is theirs: angles by default, a draft only on
  request, and nothing is saved or sent for them.
- Never turn on live writes, never call `stop` or touch the kill switch
  unless the owner explicitly asks.
- Fail soft: report a failed step and work around it. Two failures of the
  same tool in a row: stop and report.
- Never claim you signed in, posted or opened anything for the owner.
