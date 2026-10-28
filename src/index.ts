import { Bot, BOT_COMMANDS } from "./bot.js";
import { loadConfig } from "./config.js";
import { CursorClient } from "./cursor.js";
import { Store } from "./store.js";
import { TelegramClient } from "./telegram.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const telegram = new TelegramClient(config.telegramBotToken, config.telegramApiBase);
  const cursor = new CursorClient(config.cursorApiKey, config.cursorApiBase);
  const store = new Store(config.stateFile);
  await store.load();

  const bot = new Bot(config, telegram, cursor, store);

  const me = await telegram.getMe();
  await telegram.setMyCommands(BOT_COMMANDS).catch((err) => console.warn("setMyCommands failed:", err));
  console.log(
    `Bridge up as @${me.username ?? me.first_name}. Allowed users: ${[...config.allowedUserIds].join(", ")}. Repo: ${
      config.defaultRepoUrl ?? "(per chat via /repo)"
    }`,
  );

  const shutdown = new AbortController();
  const stop = () => {
    if (shutdown.signal.aborted) return;
    console.log("Shutting down...");
    shutdown.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let offset: number | undefined;
  let failures = 0;
  while (!shutdown.signal.aborted) {
    try {
      const updates = await telegram.getUpdates(offset, 30, shutdown.signal);
      failures = 0;
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) bot.enqueue(update.message);
      }
    } catch (err) {
      if (shutdown.signal.aborted) break;
      failures++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
      console.error(`getUpdates failed (attempt ${failures}), retrying in ${delay}ms:`, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  await bot.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
