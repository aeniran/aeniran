import type { Config } from "./config.js";
import { ACTIVE_RUN_STATUSES, CursorApiError, type CursorClient, type GitBranch, type Run, type RunStatus } from "./cursor.js";
import type { Store } from "./store.js";
import type { TelegramClient, TelegramMessage } from "./telegram.js";

export const BOT_COMMANDS = [
  { command: "new", description: "Start a new cloud agent: /new <task>" },
  { command: "status", description: "Show the current agent's latest run" },
  { command: "cancel", description: "Cancel the current agent's active run" },
  { command: "pr", description: "Show branches and pull requests for the current agent" },
  { command: "agents", description: "List agents started from this chat" },
  { command: "use", description: "Switch to another agent: /use <number|agent id>" },
  { command: "repo", description: "Show or set the repository: /repo <url>" },
  { command: "ref", description: "Show or set the starting branch: /ref <branch>" },
  { command: "models", description: "List available models" },
  { command: "help", description: "Show help" },
];

const HELP_TEXT = `I bridge this chat to Cursor Cloud Agents.

Send me any message and I'll hand it to a cloud agent:
- No agent yet in this chat: I start a new one on the configured repo.
- An agent exists and is idle: your message is a follow-up on that agent.
- The agent is busy: your message is steered into the running turn.

Commands:
/new <task> - always start a fresh agent
/status - latest run status
/cancel - cancel the active run
/pr - branches and PR links
/agents - agents started from this chat
/use <n|id> - switch the active agent
/repo <url> - set the repository for new agents
/ref <branch> - set the starting branch for new agents
/models - list model ids (set CURSOR_MODEL to use one)
/help - this message`;

const PROGRESS_EDIT_INTERVAL_MS = 3000;

interface WatchedRun {
  agentId: string;
  runId: string;
  abort: AbortController;
}

export class Bot {
  private readonly watched = new Map<number, WatchedRun>();
  private readonly queues = new Map<number, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly telegram: TelegramClient,
    private readonly cursor: CursorClient,
    private readonly store: Store,
  ) {}

  /** Serialises handling per chat so follow-ups keep their order. */
  enqueue(message: TelegramMessage): void {
    const chatId = message.chat.id;
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(message))
      .catch((err) => this.reportError(message, err))
      .finally(() => {
        if (this.queues.get(chatId) === next) this.queues.delete(chatId);
      });
    this.queues.set(chatId, next);
  }

  async shutdown(): Promise<void> {
    for (const run of this.watched.values()) run.abort.abort();
    await Promise.allSettled([...this.queues.values()]);
  }

  private async handle(message: TelegramMessage): Promise<void> {
    const text = message.text?.trim();
    if (!text) return;

    const from = message.from;
    if (!from || !this.config.allowedUserIds.has(from.id)) {
      console.warn(`Ignoring message from unauthorised user ${from?.id ?? "unknown"} in chat ${message.chat.id}`);
      if (message.chat.type === "private") {
        await this.reply(message, `Sorry, you're not on the allow list. Your Telegram user id is ${from?.id ?? "unknown"}.`);
      }
      return;
    }

    const parsed = parseCommand(text);
    if (!parsed) {
      await this.handlePrompt(message, text, { forceNew: false });
      return;
    }

    switch (parsed.command) {
      case "start":
      case "help":
        await this.reply(message, HELP_TEXT);
        return;
      case "new":
        if (!parsed.args) {
          await this.reply(message, "Usage: /new <task description>");
          return;
        }
        await this.handlePrompt(message, parsed.args, { forceNew: true });
        return;
      case "status":
        await this.handleStatus(message);
        return;
      case "cancel":
        await this.handleCancel(message);
        return;
      case "pr":
        await this.handlePr(message);
        return;
      case "agents":
        await this.handleAgents(message);
        return;
      case "use":
        await this.handleUse(message, parsed.args);
        return;
      case "repo":
        await this.handleRepo(message, parsed.args);
        return;
      case "ref":
        await this.handleRef(message, parsed.args);
        return;
      case "models":
        await this.handleModels(message);
        return;
      default:
        await this.reply(message, `Unknown command /${parsed.command}. Try /help.`);
    }
  }

  private async handlePrompt(message: TelegramMessage, prompt: string, opts: { forceNew: boolean }): Promise<void> {
    const chatId = message.chat.id;
    const chat = this.store.chat(chatId);
    const activeAgentId = opts.forceNew ? undefined : chat.activeAgentId;

    await this.telegram.sendChatAction(chatId);

    if (!activeAgentId) {
      await this.createAgent(message, prompt);
      return;
    }

    const watched = this.watched.get(chatId);
    if (watched && watched.agentId === activeAgentId) {
      await this.steer(message, activeAgentId, prompt);
      return;
    }

    try {
      const { run } = await this.cursor.followUp(activeAgentId, prompt);
      await this.reply(message, `Follow-up sent to agent ${shortId(activeAgentId)} (run ${shortId(run.id)}).`);
      this.watchRun(message, activeAgentId, run.id);
    } catch (err) {
      if (err instanceof CursorApiError && err.status === 409) {
        await this.steer(message, activeAgentId, prompt);
        return;
      }
      if (err instanceof CursorApiError && (err.status === 404 || err.status === 410)) {
        await this.reply(message, `Agent ${shortId(activeAgentId)} is no longer available; starting a new one.`);
        await this.createAgent(message, prompt);
        return;
      }
      throw err;
    }
  }

  private async steer(message: TelegramMessage, agentId: string, prompt: string): Promise<void> {
    try {
      const res = await this.cursor.steer(agentId, prompt);
      const note =
        res.delivery === "steered"
          ? "The agent is busy, so I steered your message into its running turn."
          : "The agent is busy; your message is queued as its next follow-up.";
      await this.reply(message, note);
      if (res.delivery === "queued" && !this.watched.has(message.chat.id)) {
        void this.pollLatestRun(message, agentId);
      }
    } catch (err) {
      if (err instanceof CursorApiError && (err.status === 403 || err.status === 409)) {
        await this.reply(
          message,
          "The agent is busy and steering isn't available. Wait for the run to finish, or /cancel it and send your message again.",
        );
        return;
      }
      throw err;
    }
  }

  private async createAgent(message: TelegramMessage, prompt: string): Promise<void> {
    const chatId = message.chat.id;
    const chat = this.store.chat(chatId);
    const repoUrl = chat.repoUrl ?? this.config.defaultRepoUrl;
    const startingRef = chat.startingRef ?? this.config.defaultStartingRef;

    if (!repoUrl) {
      await this.reply(
        message,
        "No repository configured. Set one with /repo https://github.com/your-org/your-repo (or DEFAULT_REPO_URL in the bot's environment).",
      );
      return;
    }

    const input: Parameters<CursorClient["createAgent"]>[0] = {
      prompt,
      repoUrl,
      autoCreatePr: this.config.autoCreatePr,
    };
    if (startingRef) input.startingRef = startingRef;
    if (this.config.cursorModel) input.model = this.config.cursorModel;

    const { agent, run } = await this.cursor.createAgent(input);

    await this.store.rememberAgent(chatId, {
      id: agent.id,
      name: agent.name,
      url: agent.url,
      repoUrl,
      createdAt: agent.createdAt,
    });

    await this.reply(
      message,
      [`Started agent "${agent.name}" on ${repoUrl}${startingRef ? ` (${startingRef})` : ""}.`, agent.url].join("\n"),
    );
    this.watchRun(message, agent.id, run.id);
  }

  private watchRun(message: TelegramMessage, agentId: string, runId: string): void {
    const chatId = message.chat.id;
    const existing = this.watched.get(chatId);
    if (existing) existing.abort.abort();

    const abort = new AbortController();
    const entry: WatchedRun = { agentId, runId, abort };
    this.watched.set(chatId, entry);

    void this.streamToChat(message, entry)
      .catch(async (err) => {
        if (abort.signal.aborted) return;
        console.error(`Stream for ${agentId}/${runId} failed:`, err);
        await this.safeReply(message, `Lost track of run ${shortId(runId)}: ${errorMessage(err)}\nUse /status to check on it.`);
      })
      .finally(() => {
        if (this.watched.get(chatId) === entry) this.watched.delete(chatId);
      });
  }

  private async streamToChat(message: TelegramMessage, entry: WatchedRun): Promise<void> {
    const chatId = message.chat.id;
    const { agentId, runId, abort } = entry;

    const progress = await this.telegram.sendText(chatId, `Working... (run ${shortId(runId)})`, threadOpts(message));
    const progressId = progress[progress.length - 1]?.message_id;
    let assistantText = "";
    let lastTool = "";
    let lastStatus: RunStatus | undefined;
    let lastEdit = 0;
    let pendingEdit: NodeJS.Timeout | undefined;

    const scheduleEdit = () => {
      if (!progressId || abort.signal.aborted) return;
      const now = Date.now();
      const render = () => {
        lastEdit = Date.now();
        pendingEdit = undefined;
        const lines = [`Working... (run ${shortId(runId)}${lastStatus ? `, ${lastStatus.toLowerCase()}` : ""})`];
        if (lastTool) lines.push(`Last tool: ${lastTool}`);
        const tail = assistantText.trim().slice(-600);
        if (tail) lines.push("", tail);
        void this.telegram.editText(chatId, progressId, lines.join("\n")).catch(() => undefined);
      };
      if (now - lastEdit >= PROGRESS_EDIT_INTERVAL_MS) {
        render();
      } else if (!pendingEdit) {
        pendingEdit = setTimeout(render, PROGRESS_EDIT_INTERVAL_MS - (now - lastEdit));
      }
    };

    let finalResult: Parameters<NonNullable<Parameters<CursorClient["streamRun"]>[2]["onResult"]>>[0] | undefined;

    await this.cursor.streamRun(
      agentId,
      runId,
      {
        onStatus: (status) => {
          lastStatus = status;
          scheduleEdit();
        },
        onAssistantText: (text) => {
          assistantText += text;
          scheduleEdit();
        },
        onToolCall: (call) => {
          lastTool = describeToolCall(call);
          scheduleEdit();
        },
        onResult: (result) => {
          finalResult = result;
        },
        onError: (error) => {
          console.error(`Stream error for ${agentId}/${runId}: ${error.code} ${error.message}`);
        },
      },
      abort.signal,
    );

    if (pendingEdit) clearTimeout(pendingEdit);
    if (abort.signal.aborted) return;

    if (!finalResult) {
      const run = await this.cursor.waitForTerminalRun(agentId, runId, abort.signal);
      finalResult = { status: run.status };
      if (run.result !== undefined) finalResult.text = run.result;
      if (run.durationMs !== undefined) finalResult.durationMs = run.durationMs;
      if (run.git !== undefined) finalResult.git = run.git;
    }

    const finalText = (finalResult.text ?? assistantText).trim();
    const header = `${statusLabel(finalResult.status)} run ${shortId(runId)}${
      finalResult.durationMs ? ` in ${formatDuration(finalResult.durationMs)}` : ""
    }`;
    if (progressId) await this.telegram.editText(chatId, progressId, header).catch(() => undefined);

    const parts = [header];
    if (finalText) parts.push("", finalText);
    const gitLines = formatGit(finalResult.git?.branches);
    if (gitLines) parts.push("", gitLines);
    const known = this.store.findAgent(chatId, agentId);
    if (known) parts.push("", known.url);

    await this.telegram.sendText(chatId, parts.join("\n"), threadOpts(message));
  }

  /** Used after a queued steer: wait for the agent's next run to appear, then watch it. */
  private async pollLatestRun(message: TelegramMessage, agentId: string): Promise<void> {
    const deadline = Date.now() + 2 * 60_000;
    let seen: string | undefined;
    try {
      seen = (await this.cursor.getAgent(agentId)).latestRunId;
    } catch {
      return;
    }
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const agent = await this.cursor.getAgent(agentId);
        if (agent.latestRunId && agent.latestRunId !== seen) {
          this.watchRun(message, agentId, agent.latestRunId);
          return;
        }
      } catch {
        return;
      }
    }
  }

  private async handleStatus(message: TelegramMessage): Promise<void> {
    const agentId = this.store.chat(message.chat.id).activeAgentId;
    if (!agentId) {
      await this.reply(message, "No agent in this chat yet. Send me a task to start one.");
      return;
    }
    const agent = await this.cursor.getAgent(agentId);
    const run = agent.latestRunId ? await this.cursor.getRun(agentId, agent.latestRunId) : undefined;
    const lines = [`Agent "${agent.name}" (${agent.status.toLowerCase()})`, agent.url];
    if (run) {
      lines.push(
        "",
        `Latest run ${shortId(run.id)}: ${run.status}${run.durationMs ? ` (${formatDuration(run.durationMs)})` : ""}`,
      );
      if (run.result && !ACTIVE_RUN_STATUSES.has(run.status)) lines.push("", run.result);
      const git = formatGit(run.git?.branches);
      if (git) lines.push("", git);
      if (ACTIVE_RUN_STATUSES.has(run.status) && !this.watched.has(message.chat.id)) {
        this.watchRun(message, agentId, run.id);
      }
    }
    await this.reply(message, lines.join("\n"));
  }

  private async handleCancel(message: TelegramMessage): Promise<void> {
    const agentId = this.store.chat(message.chat.id).activeAgentId;
    if (!agentId) {
      await this.reply(message, "No agent in this chat yet.");
      return;
    }
    const watched = this.watched.get(message.chat.id);
    let runId = watched?.agentId === agentId ? watched.runId : undefined;
    if (!runId) {
      const agent = await this.cursor.getAgent(agentId);
      runId = agent.latestRunId;
    }
    if (!runId) {
      await this.reply(message, "Nothing to cancel.");
      return;
    }
    try {
      await this.cursor.cancelRun(agentId, runId);
      await this.reply(message, `Cancelled run ${shortId(runId)}.`);
    } catch (err) {
      if (err instanceof CursorApiError && err.status === 409) {
        await this.reply(message, "The latest run already finished; nothing to cancel.");
        return;
      }
      throw err;
    }
  }

  private async handlePr(message: TelegramMessage): Promise<void> {
    const agentId = this.store.chat(message.chat.id).activeAgentId;
    if (!agentId) {
      await this.reply(message, "No agent in this chat yet.");
      return;
    }
    const agent = await this.cursor.getAgent(agentId);
    const run: Run | undefined = agent.latestRunId ? await this.cursor.getRun(agentId, agent.latestRunId) : undefined;
    const git = formatGit(run?.git?.branches);
    await this.reply(message, git || "The agent hasn't pushed a branch yet.");
  }

  private async handleAgents(message: TelegramMessage): Promise<void> {
    const chat = this.store.chat(message.chat.id);
    if (chat.agents.length === 0) {
      await this.reply(message, "No agents started from this chat yet.");
      return;
    }
    const lines = chat.agents.map((a, i) => {
      const marker = a.id === chat.activeAgentId ? "* " : "  ";
      return `${marker}${i + 1}. ${a.name} (${shortId(a.id)})${a.repoUrl ? ` - ${a.repoUrl}` : ""}`;
    });
    lines.push("", "Switch with /use <number>.");
    await this.reply(message, lines.join("\n"));
  }

  private async handleUse(message: TelegramMessage, arg: string): Promise<void> {
    const chatId = message.chat.id;
    const chat = this.store.chat(chatId);
    if (!arg) {
      await this.reply(message, "Usage: /use <number from /agents> or /use <agent id>");
      return;
    }
    let target = chat.agents.find((a) => a.id === arg || a.id.endsWith(arg));
    if (!target && /^\d+$/.test(arg)) target = chat.agents[Number(arg) - 1];
    if (!target && arg.startsWith("bc-")) {
      const agent = await this.cursor.getAgent(arg);
      target = { id: agent.id, name: agent.name, url: agent.url, createdAt: agent.createdAt };
      if (agent.repos?.[0]?.url) target.repoUrl = agent.repos[0].url;
      await this.store.rememberAgent(chatId, target);
    }
    if (!target) {
      await this.reply(message, `No agent matching "${arg}". See /agents.`);
      return;
    }
    const chosen = target;
    await this.store.update(chatId, (c) => {
      c.activeAgentId = chosen.id;
    });
    await this.reply(message, `Now talking to "${chosen.name}" (${shortId(chosen.id)}).\n${chosen.url}`);
  }

  private async handleRepo(message: TelegramMessage, arg: string): Promise<void> {
    const chatId = message.chat.id;
    if (!arg) {
      const current = this.store.chat(chatId).repoUrl ?? this.config.defaultRepoUrl;
      await this.reply(message, current ? `Repository for new agents: ${current}` : "No repository configured. Usage: /repo <url>");
      return;
    }
    if (!/^https?:\/\/\S+\/\S+/.test(arg)) {
      await this.reply(message, "That doesn't look like a repository URL. Example: /repo https://github.com/your-org/your-repo");
      return;
    }
    await this.store.update(chatId, (c) => {
      c.repoUrl = arg.replace(/\.git$/, "");
      delete c.activeAgentId;
    });
    await this.reply(message, `New agents in this chat will use ${arg}. Your next message starts a fresh agent.`);
  }

  private async handleRef(message: TelegramMessage, arg: string): Promise<void> {
    const chatId = message.chat.id;
    if (!arg) {
      const current = this.store.chat(chatId).startingRef ?? this.config.defaultStartingRef;
      await this.reply(message, current ? `Starting ref for new agents: ${current}` : "Using the repository's default branch. Usage: /ref <branch>");
      return;
    }
    await this.store.update(chatId, (c) => {
      c.startingRef = arg;
    });
    await this.reply(message, `New agents will start from ${arg}.`);
  }

  private async handleModels(message: TelegramMessage): Promise<void> {
    const models = await this.cursor.listModels();
    const current = this.config.cursorModel ?? "(Cursor default)";
    await this.reply(message, [`Current model: ${current}`, "", "Available:", ...models.map((m) => `- ${m}`)].join("\n"));
  }

  private reply(message: TelegramMessage, text: string): Promise<unknown> {
    return this.telegram.sendText(message.chat.id, text, { replyTo: message.message_id, ...threadOpts(message) });
  }

  private async safeReply(message: TelegramMessage, text: string): Promise<void> {
    try {
      await this.reply(message, text);
    } catch (err) {
      console.error("Failed to send Telegram message:", err);
    }
  }

  private async reportError(message: TelegramMessage, err: unknown): Promise<void> {
    console.error(`Error handling message in chat ${message.chat.id}:`, err);
    await this.safeReply(message, `Something went wrong: ${errorMessage(err)}`);
  }
}

export function parseCommand(text: string): { command: string; args: string } | undefined {
  const match = /^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  return { command: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

function threadOpts(message: TelegramMessage): { threadId?: number } {
  return message.message_thread_id ? { threadId: message.message_thread_id } : {};
}

export function describeToolCall(call: { name: string; status: string; args?: unknown }): string {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const detail =
    firstString(args, ["command", "path", "relative_workspace_path", "target_file", "pattern", "query", "url"]) ?? "";
  const clipped = detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
  return `${call.name}${clipped ? ` ${clipped}` : ""}${call.status === "running" ? " ..." : ""}`;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

export function formatGit(branches: GitBranch[] | undefined): string {
  if (!branches || branches.length === 0) return "";
  return branches
    .map((b) => {
      const parts = [`Branch: ${b.branch ?? "(none)"} on ${b.repoUrl}`];
      if (b.prUrl) parts.push(`PR: ${b.prUrl}`);
      return parts.join("\n");
    })
    .join("\n");
}

function statusLabel(status: RunStatus): string {
  switch (status) {
    case "FINISHED":
      return "Finished";
    case "ERROR":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    case "EXPIRED":
      return "Expired";
    default:
      return status;
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(-8) : id;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
