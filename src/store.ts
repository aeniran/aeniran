import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface KnownAgent {
  id: string;
  name: string;
  url: string;
  repoUrl?: string;
  createdAt: string;
}

export interface ChatState {
  repoUrl?: string;
  startingRef?: string;
  activeAgentId?: string;
  agents: KnownAgent[];
}

interface StateFile {
  version: 1;
  chats: Record<string, ChatState>;
}

const MAX_AGENTS_PER_CHAT = 20;

export class Store {
  private state: StateFile = { version: 1, chats: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as StateFile;
      if (parsed && parsed.version === 1 && parsed.chats) this.state = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  chat(chatId: number): ChatState {
    const key = String(chatId);
    let chat = this.state.chats[key];
    if (!chat) {
      chat = { agents: [] };
      this.state.chats[key] = chat;
    }
    return chat;
  }

  findAgent(chatId: number, agentId: string): KnownAgent | undefined {
    return this.chat(chatId).agents.find((a) => a.id === agentId);
  }

  async update(chatId: number, mutate: (chat: ChatState) => void): Promise<ChatState> {
    const chat = this.chat(chatId);
    mutate(chat);
    await this.save();
    return chat;
  }

  async rememberAgent(chatId: number, agent: KnownAgent): Promise<void> {
    await this.update(chatId, (chat) => {
      chat.agents = [agent, ...chat.agents.filter((a) => a.id !== agent.id)].slice(0, MAX_AGENTS_PER_CHAT);
      chat.activeAgentId = agent.id;
    });
  }

  private save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
