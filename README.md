# Cursor Telegram Bridge

A small Telegram bot that lets you chat with [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent) from Telegram. It is a thin bridge over the [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints): every message you send becomes a prompt for a cloud agent, progress is streamed back into the chat, and you get the final reply plus branch and PR links when the run finishes.

No framework and no runtime dependencies: Node 20+ with built-in `fetch`, Telegram long polling (no public URL or webhook needed), and a JSON file for state.

## How a conversation works

| You send | What happens |
| --- | --- |
| Any text, no agent in this chat yet | A new cloud agent is created on the configured repository and your text is its first prompt. |
| Any text, agent idle | Sent as a follow-up run to the current agent (same conversation and workspace). |
| Any text, agent busy | Steered into the running turn; if steering isn't available on your account, you're told to wait or `/cancel`. |
| `/new <task>` | Always starts a fresh agent. |
| `/status` | Latest run status, result, and branches for the current agent. |
| `/cancel` | Cancels the active run. |
| `/pr` | Branches and pull request URLs pushed by the current agent. |
| `/agents`, `/use <n>` | List agents started from this chat and switch between them. |
| `/repo <url>`, `/ref <branch>` | Change the repository / starting branch for new agents in this chat. |
| `/models` | List model ids you can put in `CURSOR_MODEL`. |

While a run is active the bot keeps one "Working..." message updated with the current status, the last tool call, and the tail of the agent's reply. When the run ends you get a final message with the agent's reply, the branch, the PR link (if `AUTO_CREATE_PR` is on), and a link to the run at cursor.com.

Each Telegram chat has its own current agent, so you can use a private chat for one project and a group or topic for another.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Find your Telegram user id (message [@userinfobot](https://t.me/userinfobot)). Only ids in `TELEGRAM_ALLOWED_USER_IDS` can use the bot; everyone else is ignored. This matters because every prompt spends your Cursor usage.
3. Create a Cursor API key: Cursor Dashboard -> API Keys (a user key or a service-account key).
4. Make sure the repository you want to work on is connected to Cursor Cloud Agents (same requirement as using agents from cursor.com/agents).

```bash
git clone <this repo>
cd cursor-telegram-bridge
npm install
cp .env.example .env   # fill in the values
npm start
```

Open your bot in Telegram, send `/help`, then send it a task.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Token from @BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | yes | Comma-separated Telegram user ids allowed to talk to the bot. |
| `CURSOR_API_KEY` | yes | Cursor API key. |
| `DEFAULT_REPO_URL` | no | Repository for new agents when a chat hasn't set one with `/repo`. |
| `DEFAULT_STARTING_REF` | no | Branch or commit to start from. Defaults to the repo's default branch. |
| `CURSOR_MODEL` | no | Model id from `GET /v1/models`. Omit for your Cursor default. |
| `AUTO_CREATE_PR` | no | Open a PR when a run finishes. Default `true`. |
| `STATE_FILE` | no | Where per-chat state is stored. Default `./data/state.json`. |
| `CURSOR_API_BASE`, `TELEGRAM_API_BASE` | no | Override API hosts (used for testing). |

## Running it somewhere

The bot uses long polling, so it runs anywhere that has outbound internet: a laptop, a Raspberry Pi, a small VPS, or a container platform (Fly.io, Railway, Render, a Docker host). It does not need an inbound port.

```bash
docker build -t cursor-telegram-bridge .
docker run -d --name cursor-telegram-bridge --restart unless-stopped \
  --env-file .env \
  -v cursor-telegram-bridge-data:/app/data \
  cursor-telegram-bridge
```

Mount `/app/data` (or point `STATE_FILE` somewhere persistent) so the bot remembers which agent each chat is talking to across restarts.

Run only one instance per bot token: Telegram delivers each update to a single `getUpdates` consumer.

## Development

```bash
npm run dev        # restart on changes
npm run typecheck
npm test           # unit tests (SSE parser, message splitting, command parsing)
```

Source layout:

- `src/index.ts` - startup and the Telegram long-polling loop
- `src/bot.ts` - command handling, agent lifecycle, progress streaming into the chat
- `src/cursor.ts` - Cloud Agents API client (create, follow-up, steer, runs, SSE stream with reconnect)
- `src/telegram.ts` - minimal Telegram Bot API client with message splitting and rate-limit retry
- `src/store.ts` - per-chat state (repository, current agent, recent agents)
- `src/sse.ts` - incremental Server-Sent Events parser

## Limitations

- Text only. Photos sent to the bot are not forwarded yet (the API supports images on prompts; it's a small addition).
- One active run is tracked per chat. Switching agents with `/use` while a run is streaming stops the progress updates for the old one; `/status` picks them up again.
- This is a community-style bridge, not an official Cursor integration. The Cloud Agents API is in public beta and may change.
