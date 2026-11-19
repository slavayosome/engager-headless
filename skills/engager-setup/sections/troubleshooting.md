# Setup troubleshooting

Every branch ends in "tell the owner where things stand", never in a silent
retry loop. Symptom, then fix.

## Stack problems

- `get_status` works but the browser or sign-in check fails: a component
  failed, not the install. Report the exact error and use the app's recovery
  for that component. Do not run `engager init` or keep the owner from the
  state you already read.
- An external client's `npx engager call` errors or times out: Postgres is
  down, the env file is incomplete or migrations are missing. Have the owner run
  `npx engager doctor`, and `npx engager init` only if it confirms missing
  prerequisites. Then open a fresh session.
- `engager init` fails at migrate, the same way on every re-run: read the
  error. `init` only appends missing keys, so it never corrects a wrong
  `DATABASE_URL` or `ENGAGER_MIGRATE_DATABASE_URL` (another port, a second
  server below version 15). The owner edits those two lines, then re-runs it.
- `not_configured` or `no_session`: this may be first run before sign-in.
  Leave the env file alone and go to step 2. Report a probe refusal as returned;
  do not infer a stack problem from an absent connector field.

## Background inference problems (`setup.agent`)

No selection is not a fault. A selected agent that cannot serve Engager's own
calls is. Each fix is the owner's: an env edit, or the Engager app's Settings,
Your agent.

- `error` naming a missing capability (for example Codex cannot serve
  schema-constrained JSON): set `ENGAGER_AGENT_CLI=claude` or delete the line.
  Codex still runs these skills; it just cannot serve the background calls.
- `error` beginning `unknown ENGAGER_AGENT_CLI`: a typo, or an agent with no
  local adapter. The message lists the valid values.
- `error` saying no supported agent was found: install Claude Code, sign in,
  then `npx engager doctor`.
- `installed: false` with no `error`: the binary is off PATH. `engager doctor`
  prints the one it probed; install it or set `ENGAGER_AGENT_CLI_BIN`.
- A `models[]` row with `declared: false`: one role's calls fail because the
  installed agent does not offer its model. Re-run `engager agent configure`
  with that role set to a model `engager agent discover --json` reports.
  Editing `ENGAGER_MODEL_*` does nothing once roles are stored.

## Browser session problems

- `needs_signin` after the owner says they signed in: the profile is signed
  out or LinkedIn raised a checkpoint (2FA, unusual login). Ask what they saw,
  fix that, probe once more.
- `account_restricted`: waiting cannot fix it. Stop and report; the owner
  resolves it with LinkedIn.
- The browser never opens or the probe hangs: another process holds the
  browser profile, a second session or a standing agent process. Close the
  other one, try once.

## Brain, voice and product problems

- The seed finished and the Brain is empty: the account has no usable posts.
  Offer the blurb or site source from step 4. `not_connected` is step 2's
  problem, not the Brain's. Never fabricate a fact to fill a slot.
- The provisional Voice reads wrong: do not argue or rewrite it. Their saved
  comments calibrate it; for edits go to **engager-voice-and-brain**.
- A product link fails or its facts stay empty: fix the link with the owner or
  save the product without one; facts belong to **engager-voice-and-brain**.

## Finish refusals (`complete_setup`)

Each refusal names its missing fact. Fix the fact, never work around it.

- `setup_workflow_required`: send `loadedSkills` with this skill's name and
  frontmatter version on the call itself.
- `setup_linkedin_required`: the account is not `live`. Return to step 2 and
  report the connection and probe results.
- `setup_campaign_required`: no campaign has started. Expected on a first run.
  Hand off to **engager-campaigns**, then finish after the owner's Start.
- `setup_owner_credential_required`: the organization has no single owner.
  `npx engager init` repairs it.

## When to stop entirely

Two unexpected failures in a row, or the kill switch is on: stop, say what is
done, and report what failed.
