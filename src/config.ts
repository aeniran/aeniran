import { existsSync } from "node:fs";

export interface Config {
  telegramBotToken: string;
  telegramApiBase: string;
  allowedUserIds: Set<number>;
  cursorApiKey: string;
  cursorApiBase: string;
  defaultRepoUrl: string | undefined;
  defaultStartingRef: string | undefined;
  cursorModel: string | undefined;
  autoCreatePr: boolean;
  stateFile: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function loadConfig(): Config {
  if (existsSync(".env")) {
    try {
      process.loadEnvFile(".env");
    } catch {
      // Older Node versions without loadEnvFile; rely on the environment as-is.
    }
  }

  const allowedUserIds = new Set(
    required("TELEGRAM_ALLOWED_USER_IDS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const id = Number(s);
        if (!Number.isInteger(id)) {
          throw new Error(`TELEGRAM_ALLOWED_USER_IDS contains a non-numeric id: "${s}"`);
        }
        return id;
      }),
  );
  if (allowedUserIds.size === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must list at least one Telegram user id");
  }

  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramApiBase: optional("TELEGRAM_API_BASE") ?? "https://api.telegram.org",
    allowedUserIds,
    cursorApiKey: required("CURSOR_API_KEY"),
    cursorApiBase: (optional("CURSOR_API_BASE") ?? "https://api.cursor.com").replace(/\/$/, ""),
    defaultRepoUrl: optional("DEFAULT_REPO_URL"),
    defaultStartingRef: optional("DEFAULT_STARTING_REF"),
    cursorModel: optional("CURSOR_MODEL"),
    autoCreatePr: parseBool(optional("AUTO_CREATE_PR"), true),
    stateFile: optional("STATE_FILE") ?? "./data/state.json",
  };
}
