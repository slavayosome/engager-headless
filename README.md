# Engager headless

Run Engager on your own machine and use it from the command line or through your AI agent over MCP. The headless runtime stores its data in local PostgreSQL. It uses your own agent for model calls. Installing it and reading local status require no Engager account, card, or subscription.

You can start a draft campaign for free. Ask your local agent to start it, review the campaign and its actions in the Mac dialog, then choose **Start campaign**. The official Mac app includes the dashboard for $29/month. [Engager for Mac](https://getengager.com)

## Install on an Apple Silicon Mac

From a terminal with Homebrew installed, set up Node.js, PostgreSQL and uv. These commands use a local PostgreSQL 17 server owned by your macOS user.

```sh
brew install node@22 postgresql@17 uv
export PATH="$(brew --prefix node@22)/bin:$(brew --prefix postgresql@17)/bin:$PATH"
brew services start postgresql@17
```

Clone or download this repository to a permanent directory. From that directory, run the following commands.

```sh
npm ci
npm run engager -- init
npm run --silent engager -- call get_status
npm run --silent engager -- call list_skills
```

On a fresh install, the status shows an empty local organization. Setup creates the database, writes the local connection details and encryption key to `.env`, installs the Engager skills, and registers the local MCP server for Codex and for Claude Code when installed. Keep the checkout in place so those registrations keep working. Keep your `.env` private and back it up with your local data.

## Run the background process

For LinkedIn work, build the headless runtime and install its dedicated browser and Python tools first. The browser check runs locally.

```sh
npm run build
npm run engager -- mac-setup run browser
npm run engager -- mac-setup run browser-check
```

Start the scheduler and worker from the checkout.

```sh
npm run up
```

Leave this command running to serve the scheduler and worker. Ctrl-C stops them. The one-shot status and skills commands also work while the background process is stopped. Open a new session of your configured agent to use the installed MCP tools and skills. Model calls require your own authenticated agent. LinkedIn operations require your own connected account. Automated activity can lead to account restrictions.

To request the same confirmation from a terminal, substitute your draft's campaign ID and run this in your logged-in Mac session.

```sh
npm run --silent engager -- call run_campaign '{"campaignId":1,"run":"start"}'
```

Engager sends anonymous product telemetry to its relay. To inspect what is collected, see the [event definitions](packages/observability/events.ts).

## License

Engager headless is distributed under the GNU Affero General Public License, version 3 or any later version. Third-party dependencies retain their own licenses. [License text](LICENSE)
