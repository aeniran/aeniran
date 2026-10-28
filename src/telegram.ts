export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  message_thread_id?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export class TelegramApiError extends Error {
  constructor(
    public readonly code: number,
    public readonly description: string,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram API ${code}: ${description}`);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(token: string, apiBase: string) {
    this.baseUrl = `${apiBase.replace(/\/$/, "")}/bot${token}`;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    const json = (await res.json()) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!json.ok) {
      throw new TelegramApiError(
        json.error_code ?? res.status,
        json.description ?? "unknown error",
        json.parameters?.retry_after,
      );
    }
    return json.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call("getMe");
  }

  setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    return this.call("setMyCommands", { commands });
  }

  getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message"],
      },
      signal,
    );
  }

  /**
   * Send plain text, splitting into several messages when it exceeds the
   * Telegram limit. Returns the sent messages in order.
   */
  async sendText(chatId: number, text: string, opts: { replyTo?: number; threadId?: number } = {}): Promise<TelegramMessage[]> {
    const sent: TelegramMessage[] = [];
    const chunks = splitMessage(text || "(empty)", TELEGRAM_MAX_MESSAGE_LENGTH);
    for (const [index, chunk] of chunks.entries()) {
      const params: Record<string, unknown> = {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      };
      if (opts.threadId) params.message_thread_id = opts.threadId;
      if (opts.replyTo && index === 0) {
        params.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
      }
      sent.push(await this.withRetry(() => this.call<TelegramMessage>("sendMessage", params)));
    }
    return sent;
  }

  async editText(chatId: number, messageId: number, text: string): Promise<void> {
    const clipped = splitMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH)[0] ?? text;
    try {
      await this.withRetry(() =>
        this.call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: clipped,
          disable_web_page_preview: true,
        }),
      );
    } catch (err) {
      // Telegram rejects edits that don't change the message; that's fine.
      if (err instanceof TelegramApiError && /message is not modified/i.test(err.description)) return;
      throw err;
    }
  }

  async sendChatAction(chatId: number, action: "typing" = "typing"): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      // Best effort only.
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof TelegramApiError && err.code === 429 && attempt < 3) {
          await new Promise((r) => setTimeout(r, ((err.retryAfter ?? 1) + 0.5) * 1000));
          continue;
        }
        throw err;
      }
    }
  }
}

/**
 * Split text into chunks no longer than `limit`, preferring to break on
 * paragraph, then line, then word boundaries.
 */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = window.lastIndexOf(" ");
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
