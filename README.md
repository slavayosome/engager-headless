<p align="center">
  <a href="https://getengager.com"><img src="https://getengager.com/landing/engager-mark-tile.svg" width="80" height="80" alt="Engager logo"></a>
</p>

<h1 align="center">Engager</h1>
<p align="center"><strong>The open-source go-to-market engine for AI-native founders.</strong></p>

<p align="center">
  <a href="https://github.com/slavayosome/engager-headless/releases/latest"><img src="https://img.shields.io/github/v/release/slavayosome/engager-headless?style=flat&amp;label=release&amp;color=ab684f" alt="Latest release"></a>
  <a href="https://github.com/slavayosome/engager-headless/actions/workflows/headless.yml"><img src="https://github.com/slavayosome/engager-headless/actions/workflows/headless.yml/badge.svg?branch=main" alt="Headless install checks"></a>
  <a href="https://github.com/slavayosome/engager-headless/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-65588b?style=flat" alt="AGPL-3.0-or-later license"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/macOS-Apple%20Silicon-484644?logo=apple&amp;logoColor=white" alt="Runs on Apple Silicon Macs"></a>
</p>

<p align="center"><a href="#quick-start">Quick start</a> · <a href="#try-it-with-your-agent">Example prompts</a> · <a href="https://getengager.com">Mac app</a></p>

Find potential customers through public conversations. Give Engager your audience and your product. Scout finds people who fit and shows you why.

**Channels** · LinkedIn is available today. X is coming soon.

## Try it with your agent

<p><img src="https://getengager.com/agent-marks/claude-icon.svg" width="20" height="20" alt=""> <strong>Claude Code</strong> &nbsp;·&nbsp; <img src="https://getengager.com/agent-marks/codex-mark.png" width="20" height="20" alt=""> <strong>Codex</strong></p>

Give your agent your **ideal customer profile (ICP)**. For Engager itself, we’d ask:

> Use Engager to find early-stage founders, solo builders, and indie hackers on LinkedIn who are seeing early traction. Ask me what counts as traction, then walk me through my strategy options: how deeply to research each person and whether to find leads only, draft comments and replies for my review, or engage automatically. Recommend a starting point and show me the plan before we start.

Once you have matches, try **“Why did you pick this founder?”**, **“Give me two ways to start a conversation”**, or **“Which founders replied this week?”**

## How Engager works

**Claude Code or Codex** helps you choose searches, assess people, and write replies. **Engager Core** runs on your Mac. It schedules workers, keeps conversation history, and checks permissions and limits before sending. While Core is running, workers can continue after you close the chat.

### Campaigns and strategy

A **campaign** has one audience, one goal, and one channel. For founders with early traction, Scout might search LinkedIn for “my first paying customer” or “users came back for a second week.”

Goals include useful conversations, visibility, audience growth, relationship nurture, thought leadership, and product promotion. The goal guides the writing. A product promotion campaign can mention your product when it fits the conversation.

| Starting point | What Engager does |
| --- | --- |
| **Find leads only** | Researches people. You handle outreach. |
| **Find and draft** | Also drafts comments and replies for your approval. |
| **Find and engage** | Sends comments and replies automatically within channel limits once you confirm the campaign and enable live sending. |

The **strategy** is the sequence of steps you can edit with your agent. Each outreach action has a mode. **Off** skips it, **Ask me** waits for approval, and **Automatic** runs within channel limits. For example, you can review comments and connection requests and leave direct messages off.

### Workers

- **Scout** finds people and saves the words behind each match. **Quick** looks for signals in posts. **Standard** can also read threads and research profiles. **Deep** adds company research and can combine what a person has said across days.
- **Ambassador** handles the contact steps you enable. It can comment on posts, join a thread, reply when someone answers, invite them to connect, or message them after they accept.

### Leads, angles, and drafts

A **signal** is something someone wrote. A **lead** is a person Scout has researched. Ask for their role, About section, recent posts, or company information where available. You can trace a match back to its original quote and link.

**Fit** explains why someone matches your audience. A solo builder with three paying customers fits this campaign. **Intent** comes from what they say. If that builder asks how to find customer four, they’re looking for advice.

Ask for **angles** when you want ways into a conversation. You might ask, “How did those first customers describe the problem?” or suggest searching for a phrase those customers used. Pick an angle, ask for a **draft**, or write your own. Exploring angles and drafts in chat leaves sending up to you.

Engager remembers details you add, such as “Their first three customers came through referrals.” You can set a lead aside, mark them as a peer, or record a booked demo.

### Inbox and activity

**Inbox** shows who engaged back. A **conversation** is your history with one person. A **thread** contains everyone’s comments under one post. Say **“I’ll take this one”** to cancel queued outreach to that person and handle the conversation yourself until you hand it back.

**Activity** shows what needs approval, what’s scheduled, what went out, and what came back. Ask why a comment is waiting to see the relevant approval, limit, or sending window.

### Brain and Voice

- **Brain notes** hold your expertise, opinions, firsthand stories, and topics to avoid. On a headless install, they’re plain Markdown files in `~/.engager/brain/` by default. Edit them in Obsidian, any text editor, or through your agent.
- **Products** live in your Brain. Record who each product serves, what it does, and the evidence for its claims. Link it to a campaign. Engager’s own entry might pair a sample lead with the evidence Scout found. You can also approve the exact wording of an offer Ambassador may make in a DM. Product records live in local PostgreSQL.
- **Voice** shapes how drafts sound. Give your agent comments you wrote and preferences such as “Ask one specific question about what’s working.” Use a default voice or choose one per campaign. Voice learns from your own comments.

### Channels and limits

A **channel** is a connected account. All campaigns on that account share its search and profile-read limits, outreach caps, sending hours, and spacing between actions.

Approving a worker’s draft keeps it under the worker caps. Comments you write yourself still follow spacing, per-person limits, and stops. Ask how much of today’s budget remains, pause one campaign, or stop sending across the channel.

## Quick start

**Self-host for free on an Apple Silicon Mac.** You’ll need Homebrew and an authenticated Claude Code or Codex installation. You can install Engager, check its status, and start campaigns without an Engager account or subscription. The Mac app with a dashboard is **$29/month**. [Engager for Mac](https://getengager.com)

**1. Install Engager.** Open Claude Code or Codex and ask:

> Install Engager from https://github.com/slavayosome/engager-headless using its README. Set up the browser, start the worker, and check that Engager is ready.

**2. Connect LinkedIn and choose a strategy.** Open a fresh agent session and use your own audience in this prompt:

> Use Engager to connect my LinkedIn account. I want to find early-stage founders, solo builders, and indie hackers with early traction. Walk me through my options and show me a draft campaign with its searches, research depth, and enabled actions.

Sign in through the browser window your agent opens. To review the first matches yourself, choose **Find leads only**.

**3. Set channel limits.**

> Use Engager to show me my current LinkedIn limits. Help me set search and profile-read limits. If outreach is on, walk me through daily caps, sending hours, and spacing. Show me my changes before applying them.

**4. Start the campaign.** Say **“Start this campaign.”** Review the actions in the Mac dialog and click **Start campaign**. Later, ask **“Which founders did we find?”** or **“Pause this campaign.”**

## Developer shortcuts

### Install and check status

```sh
brew install node@22 postgresql@17 uv
export PATH="$(brew --prefix node@22)/bin:$(brew --prefix postgresql@17)/bin:$PATH"
brew services start postgresql@17

git clone https://github.com/slavayosome/engager-headless.git
cd engager-headless
npm ci
npm run engager -- init
npm run --silent engager -- call get_status
npm run --silent engager -- call list_skills
```

A fresh install shows an empty workspace and a disconnected LinkedIn account. Setup registers Engager’s MCP server with your agent clients. Keep the checkout in place.

### Set up the browser and start the worker

```sh
npm run build
npm run engager -- mac-setup run browser
npm run engager -- mac-setup run browser-check
npm run up
```

Keep this terminal running. Press `Ctrl-C` to stop the worker.

### Sign in to LinkedIn

Open a second terminal in the checkout and run:

```sh
npm run --silent engager -- call get_channel '{"include":["connection"],"probe":true,"openSignIn":true,"waitForSignInMs":30000}'
```

If sign-in times out, finish in the same window, then recheck:

```sh
npm run --silent engager -- call get_channel '{"include":["connection"],"probe":true,"recheck":true,"waitForSignInMs":30000}'
```

### Start a draft campaign

Replace `1` with your campaign ID. Review the actions in the Mac dialog and click **Start campaign**.

```sh
npm run --silent engager -- call run_campaign '{"campaignId":1,"run":"start"}'
```

## Data and license

Back up local PostgreSQL (campaigns, leads, products, and conversation history) and your Brain notes folder (`~/.engager/brain/` or `ENGAGER_BRAIN_DIR`). Keep the checkout’s `.env` private. Your configured agent handles model calls. Automated LinkedIn activity can lead to account restrictions.

Engager sends anonymous product telemetry. Set `ENGAGER_TELEMETRY=off` to disable it. [Telemetry event definitions](https://github.com/slavayosome/engager-headless/blob/main/packages/observability/events.ts)

Engager Headless is licensed under **AGPL-3.0-or-later**. [Read the license](https://github.com/slavayosome/engager-headless/blob/main/LICENSE)
