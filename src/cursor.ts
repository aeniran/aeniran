import { readSseStream, type SseEvent } from "./sse.js";

export type RunStatus =
  | "CREATING"
  | "RUNNING"
  | "WAITING_FOR_BACKGROUND_WORK"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED";

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "CREATING",
  "RUNNING",
  "WAITING_FOR_BACKGROUND_WORK",
]);

export interface GitBranch {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
}

export interface Run {
  id: string;
  agentId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  result?: string;
  git?: { branches: GitBranch[] };
}

export interface Agent {
  id: string;
  name: string;
  status: "ACTIVE" | "IDLE" | "ARCHIVED";
  url: string;
  createdAt: string;
  updatedAt: string;
  latestRunId?: string;
  repos?: { url: string; startingRef?: string }[];
}

export interface CreateAgentInput {
  prompt: string;
  repoUrl?: string;
  startingRef?: string;
  model?: string;
  autoCreatePr?: boolean;
  name?: string;
}

export interface StreamEvents {
  onStatus?: (status: RunStatus) => void;
  onAssistantText?: (text: string) => void;
  onToolCall?: (call: { callId: string; name: string; status: string; args?: unknown }) => void;
  onResult?: (result: {
    status: RunStatus;
    text?: string;
    durationMs?: number;
    git?: { branches: GitBranch[] };
  }) => void;
  onError?: (error: { code: string; message: string }) => void;
}

export class CursorApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CursorApiError";
  }
}

export class CursorClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const err = (json ?? {}) as { error?: { code?: string; message?: string }; code?: string; message?: string };
      const code = err.error?.code ?? err.code;
      const message = err.error?.message ?? err.message ?? text ?? res.statusText;
      throw new CursorApiError(res.status, code, `Cursor API ${res.status}${code ? ` ${code}` : ""}: ${message}`);
    }
    return json as T;
  }

  async createAgent(input: CreateAgentInput): Promise<{ agent: Agent; run: Run }> {
    const body: Record<string, unknown> = {
      prompt: { text: input.prompt },
    };
    if (input.repoUrl) {
      const repo: Record<string, string> = { url: input.repoUrl };
      if (input.startingRef) repo.startingRef = input.startingRef;
      body.repos = [repo];
    }
    if (input.model) body.model = { id: input.model };
    if (input.autoCreatePr !== undefined) body.autoCreatePR = input.autoCreatePr;
    if (input.name) body.name = input.name.slice(0, 100);
    return this.request("POST", "/v1/agents", body);
  }

  getAgent(agentId: string): Promise<Agent> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
  }

  async listAgents(limit = 10): Promise<Agent[]> {
    const res = await this.request<{ items?: Agent[]; agents?: Agent[] }>(
      "GET",
      `/v1/agents?limit=${limit}`,
    );
    return res.items ?? res.agents ?? [];
  }

  followUp(agentId: string, prompt: string): Promise<{ run: Run }> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      prompt: { text: prompt },
    });
  }

  steer(agentId: string, prompt: string): Promise<{ delivery: "steered" | "queued"; runId?: string }> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      prompt: { text: prompt },
      delivery: "steer",
    });
  }

  getRun(agentId: string, runId: string): Promise<Run> {
    return this.request(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  async listRuns(agentId: string, limit = 5): Promise<Run[]> {
    const res = await this.request<{ items?: Run[] }>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}/runs?limit=${limit}`,
    );
    return res.items ?? [];
  }

  cancelRun(agentId: string, runId: string): Promise<{ id: string }> {
    return this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
    );
  }

  async listModels(): Promise<string[]> {
    const res = await this.request<{ models?: ({ id: string } | string)[] }>("GET", "/v1/models");
    return (res.models ?? []).map((m) => (typeof m === "string" ? m : m.id));
  }

  /**
   * Stream a run until it terminates. Reconnects with Last-Event-ID on
   * transient failures; falls back to Get A Run when the stream has expired.
   */
  async streamRun(agentId: string, runId: string, handlers: StreamEvents, signal?: AbortSignal): Promise<void> {
    const path = `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
    let lastEventId: string | undefined;
    let attempts = 0;

    for (;;) {
      if (signal?.aborted) return;
      let res: Response;
      try {
        const extra: Record<string, string> = { Accept: "text/event-stream" };
        if (lastEventId) extra["Last-Event-ID"] = lastEventId;
        res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(extra), signal });
      } catch (err) {
        if (signal?.aborted) return;
        if (++attempts > 5) throw err;
        await sleep(backoffMs(attempts));
        continue;
      }

      if (res.status === 410 || res.status === 400) {
        const run = await this.waitForTerminalRun(agentId, runId, signal);
        const payload: Parameters<NonNullable<StreamEvents["onResult"]>>[0] = { status: run.status };
        if (run.result !== undefined) payload.text = run.result;
        if (run.durationMs !== undefined) payload.durationMs = run.durationMs;
        if (run.git !== undefined) payload.git = run.git;
        handlers.onResult?.(payload);
        return;
      }
      if (!res.ok || !res.body) {
        if (++attempts > 5) {
          throw new CursorApiError(res.status, undefined, `Stream request failed with ${res.status}`);
        }
        await sleep(backoffMs(attempts));
        continue;
      }

      attempts = 0;
      let finished = false;
      try {
        for await (const event of readSseStream(res.body, signal)) {
          if (event.id) lastEventId = event.id;
          if (dispatch(event, handlers)) finished = true;
          if (event.event === "done") return;
        }
      } catch (err) {
        if (signal?.aborted) return;
        if (finished) return;
        if (++attempts > 5) throw err;
      }
      if (finished) return;
      await sleep(backoffMs(Math.max(attempts, 1)));
    }
  }

  async waitForTerminalRun(agentId: string, runId: string, signal?: AbortSignal): Promise<Run> {
    for (;;) {
      const run = await this.getRun(agentId, runId);
      if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;
      if (signal?.aborted) return run;
      await sleep(5000);
    }
  }
}

function dispatch(event: SseEvent, handlers: StreamEvents): boolean {
  let payload: unknown;
  try {
    payload = event.data ? JSON.parse(event.data) : {};
  } catch {
    return false;
  }
  const data = payload as Record<string, unknown>;
  switch (event.event) {
    case "status":
      handlers.onStatus?.(data.status as RunStatus);
      return false;
    case "assistant":
      if (typeof data.text === "string") handlers.onAssistantText?.(data.text);
      return false;
    case "tool_call":
      handlers.onToolCall?.(data as { callId: string; name: string; status: string; args?: unknown });
      return false;
    case "result":
      handlers.onResult?.(data as Parameters<NonNullable<StreamEvents["onResult"]>>[0]);
      return true;
    case "error":
      handlers.onError?.(data as { code: string; message: string });
      return false;
    default:
      return false;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
