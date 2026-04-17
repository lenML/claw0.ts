/**
 * Section 04: Channels (TypeScript 版本)
 * "同一大脑, 多个嘴巴"
 *
 * Channel 封装了平台差异, 使 agent 循环只看到统一的 InboundMessage。
 * 添加新平台 = 实现 receive() + send(); 循环不需要改动。
 *
 * 运行方法:
 *   npx ts-node s04_channels.ts
 *
 * 需要在 .env 中配置:
 *   OPENAI_API_KEY=sk-xxxxx
 *   MODEL_ID=gpt-4o
 *   可选: TELEGRAM_BOT_TOKEN, FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_ENCRYPT_KEY
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as crypto from "node:crypto";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";

// 条件导入 httpx 替代品：使用 axios 或 node-fetch，这里用内置 fetch (Node 18+)
// 为简化，直接用 fetch。

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
// 注意：根据用户要求，.env 位于 __dirname 的 "../../.env"
dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: true });

const MODEL_ID = process.env.MODEL_ID || "gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

if (!OPENAI_API_KEY) {
  console.error("\x1b[33mError: OPENAI_API_KEY 未设置.\x1b[0m");
  console.error("\x1b[2m将 .env.example 复制为 .env 并填入你的 key.\x1b[0m");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

const WORKSPACE_DIR = path.resolve(__dirname, "../../../workspace");
const STATE_DIR = path.join(WORKSPACE_DIR, ".state");

// 确保目录存在
fs.mkdir(WORKSPACE_DIR, { recursive: true }).catch(() => {});
fs.mkdir(STATE_DIR, { recursive: true }).catch(() => {});

const SYSTEM_PROMPT = [
  "You are a helpful AI assistant connected to multiple messaging channels.",
  "You can save and search notes using the provided tools.",
  "When responding, be concise and helpful.",
].join("\n");

// ---------------------------------------------------------------------------
// ANSI 颜色
// ---------------------------------------------------------------------------
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";

function printAssistant(text: string, ch: string = "cli"): void {
  const prefix = ch !== "cli" ? `[${ch}] ` : "";
  console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${prefix}${text}\n`);
}

function printTool(name: string, detail: string): void {
  console.log(`  ${DIM}[tool: ${name}] ${detail}${RESET}`);
}

function printInfo(text: string): void {
  console.log(`${DIM}${text}${RESET}`);
}

function printChannel(text: string): void {
  console.log(`${BLUE}${text}${RESET}`);
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------
interface InboundMessage {
  text: string;
  senderId: string;
  channel: string;
  accountId: string;
  peerId: string;
  isGroup: boolean;
  media: any[];
  raw: any;
}

interface ChannelAccount {
  channel: string;
  accountId: string;
  token: string;
  config: Record<string, any>;
}

// ---------------------------------------------------------------------------
// 会话键构建
// ---------------------------------------------------------------------------
function buildSessionKey(
  channel: string,
  accountId: string,
  peerId: string
): string {
  return `agent:main:direct:${channel}:${peerId}`;
}

// ---------------------------------------------------------------------------
// Channel 抽象基类
// ---------------------------------------------------------------------------
abstract class Channel {
  abstract name: string;

  abstract receive(): Promise<InboundMessage | null>;
  abstract send(to: string, text: string, kwargs?: any): Promise<boolean>;

  close(): void {}
}

// ---------------------------------------------------------------------------
// CLIChannel
// ---------------------------------------------------------------------------
class CLIChannel extends Channel {
  name = "cli";
  accountId = "cli-local";
  private rl: readline.Interface | null = null;

  constructor() {
    super();
  }

  async receive(): Promise<InboundMessage | null> {
    // 使用 readline 提问，但由于可能需要非阻塞，这里采用同步风格但异步包装
    return new Promise((resolve) => {
      if (!this.rl) {
        this.rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
      }
      this.rl.question(`${CYAN}${BOLD}You > ${RESET}`, (answer) => {
        const text = answer.trim();
        if (!text) {
          resolve(null);
          return;
        }
        resolve({
          text,
          senderId: "cli-user",
          channel: "cli",
          accountId: this.accountId,
          peerId: "cli-user",
          isGroup: false,
          media: [],
          raw: {},
        });
      });
    });
  }

  async send(to: string, text: string, kwargs?: any): Promise<boolean> {
    printAssistant(text);
    return true;
  }

  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 偏移量持久化辅助
// ---------------------------------------------------------------------------
async function saveOffset(filePath: string, offset: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, String(offset), "utf-8");
}

async function loadOffset(filePath: string): Promise<number> {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// TelegramChannel -- Bot API 长轮询
// ---------------------------------------------------------------------------
class TelegramChannel extends Channel {
  name = "telegram";
  static MAX_MSG_LEN = 4096;

  accountId: string;
  private baseUrl: string;
  private allowedChats: Set<string>;
  private offsetPath: string;
  private offset: number = 0;
  private seen: Set<number> = new Set();
  private mediaGroups: Map<string, { ts: number; entries: any[] }> = new Map();
  private textBuf: Map<
    string,
    { text: string; msg: InboundMessage; ts: number }
  > = new Map();
  private pollingActive: boolean = false;

  constructor(account: ChannelAccount) {
    super();
    this.accountId = account.accountId;
    this.baseUrl = `https://api.telegram.org/bot${account.token}`;
    const raw = account.config.allowed_chats || "";
    this.allowedChats = new Set(
      raw
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
    );
    this.offsetPath = path.join(
      STATE_DIR,
      "telegram",
      `offset-${this.accountId}.txt`
    );
    // 异步初始化 offset
    loadOffset(this.offsetPath).then((v) => (this.offset = v));
  }

  private async api(
    method: string,
    params: Record<string, any> = {}
  ): Promise<any> {
    const filtered = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v != null)
    );
    try {
      const resp = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filtered),
      });
      const data = await resp.json();
      if (!data.ok) {
        console.log(
          `  ${RED}[telegram] ${method}: ${data.description || "?"}${RESET}`
        );
        return {};
      }
      return data.result || {};
    } catch (err: any) {
      console.log(`  ${RED}[telegram] ${method}: ${err.message}${RESET}`);
      return {};
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.api("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  async poll(): Promise<InboundMessage[]> {
    const result = await this.api("getUpdates", {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ["message"],
    });
    if (!result || !Array.isArray(result)) {
      return this.flushAll();
    }

    for (const update of result) {
      const uid = update.update_id || 0;
      if (uid >= this.offset) {
        this.offset = uid + 1;
        await saveOffset(this.offsetPath, this.offset);
      }
      if (this.seen.has(uid)) continue;
      this.seen.add(uid);
      if (this.seen.size > 5000) this.seen.clear();

      const msg = update.message;
      if (!msg) continue;
      if (msg.media_group_id) {
        this.bufMedia(msg, update);
        continue;
      }
      const inbound = this.parse(msg, update);
      if (!inbound) continue;
      if (this.allowedChats.size > 0 && !this.allowedChats.has(inbound.peerId))
        continue;
      this.bufText(inbound);
    }
    return this.flushAll();
  }

  private flushAll(): InboundMessage[] {
    const ready = this.flushMedia();
    ready.push(...this.flushText());
    return ready;
  }

  private bufMedia(msg: any, update: any): void {
    const mgid = msg.media_group_id;
    if (!this.mediaGroups.has(mgid)) {
      this.mediaGroups.set(mgid, { ts: Date.now() / 1000, entries: [] });
    }
    this.mediaGroups.get(mgid)!.entries.push([msg, update]);
  }

  private flushMedia(): InboundMessage[] {
    const now = Date.now() / 1000;
    const ready: InboundMessage[] = [];
    for (const [mgid, group] of this.mediaGroups.entries()) {
      if (now - group.ts >= 0.5) {
        this.mediaGroups.delete(mgid);
        const entries = group.entries;
        const captions: string[] = [];
        const mediaItems: any[] = [];
        for (const [m] of entries) {
          if (m.caption) captions.push(m.caption);
          for (const mt of ["photo", "video", "document", "audio"]) {
            if (m[mt]) {
              const rawM = m[mt];
              const fid = Array.isArray(rawM)
                ? rawM[rawM.length - 1]?.file_id
                : rawM?.file_id;
              mediaItems.push({ type: mt, file_id: fid });
            }
          }
        }
        const inbound = this.parse(entries[0][0], entries[0][1]);
        if (inbound) {
          inbound.text = captions.join("\n") || "[media group]";
          inbound.media = mediaItems;
          if (
            this.allowedChats.size === 0 ||
            this.allowedChats.has(inbound.peerId)
          ) {
            ready.push(inbound);
          }
        }
      }
    }
    return ready;
  }

  private bufText(inbound: InboundMessage): void {
    const key = `${inbound.peerId}:${inbound.senderId}`;
    const now = Date.now() / 1000;
    const existing = this.textBuf.get(key);
    if (existing) {
      existing.text += "\n" + inbound.text;
      existing.ts = now;
    } else {
      this.textBuf.set(key, { text: inbound.text, msg: inbound, ts: now });
    }
  }

  private flushText(): InboundMessage[] {
    const now = Date.now() / 1000;
    const ready: InboundMessage[] = [];
    for (const [key, buf] of this.textBuf.entries()) {
      if (now - buf.ts >= 1.0) {
        this.textBuf.delete(key);
        buf.msg.text = buf.text;
        ready.push(buf.msg);
      }
    }
    return ready;
  }

  private parse(msg: any, rawUpdate: any): InboundMessage | null {
    const chat = msg.chat || {};
    const chatType = chat.type || "";
    const chatId = String(chat.id || "");
    const userId = String(msg.from?.id || "");
    const text = msg.text || msg.caption || "";
    if (!text) return null;

    const threadId = msg.message_thread_id;
    const isForum = chat.is_forum || false;
    const isGroup = chatType === "group" || chatType === "supergroup";

    let peerId: string;
    if (chatType === "private") {
      peerId = userId;
    } else if (isGroup && isForum && threadId != null) {
      peerId = `${chatId}:topic:${threadId}`;
    } else {
      peerId = chatId;
    }

    return {
      text,
      senderId: userId,
      channel: "telegram",
      accountId: this.accountId,
      peerId,
      isGroup,
      media: [],
      raw: rawUpdate,
    };
  }

  async receive(): Promise<InboundMessage | null> {
    const msgs = await this.poll();
    return msgs.length > 0 ? msgs[0] : null;
  }

  async send(to: string, text: string, kwargs?: any): Promise<boolean> {
    let chatId = to;
    let threadId: number | undefined;
    if (to.includes(":topic:")) {
      const parts = to.split(":topic:");
      chatId = parts[0];
      threadId = parts[1] ? parseInt(parts[1], 10) : undefined;
    }
    let ok = true;
    for (const chunk of this.chunk(text)) {
      const res = await this.api("sendMessage", {
        chat_id: chatId,
        text: chunk,
        message_thread_id: threadId,
      });
      if (!res || Object.keys(res).length === 0) ok = false;
    }
    return ok;
  }

  private chunk(text: string): string[] {
    if (text.length <= TelegramChannel.MAX_MSG_LEN) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= TelegramChannel.MAX_MSG_LEN) {
        chunks.push(remaining);
        break;
      }
      let cut = remaining.lastIndexOf("\n", TelegramChannel.MAX_MSG_LEN);
      if (cut <= 0) cut = TelegramChannel.MAX_MSG_LEN;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^\n+/, "");
    }
    return chunks;
  }

  close(): void {
    this.pollingActive = false;
  }
}

// ---------------------------------------------------------------------------
// FeishuChannel -- 基于 webhook (飞书/Lark) 简化版，只实现发送
// ---------------------------------------------------------------------------
class FeishuChannel extends Channel {
  name = "feishu";
  accountId: string;
  private appId: string;
  private appSecret: string;
  private encryptKey: string;
  private botOpenId: string;
  private apiBase: string;
  private tenantToken: string = "";
  private tokenExpiresAt: number = 0;

  constructor(account: ChannelAccount) {
    super();
    this.accountId = account.accountId;
    this.appId = account.config.app_id || "";
    this.appSecret = account.config.app_secret || "";
    this.encryptKey = account.config.encrypt_key || "";
    this.botOpenId = account.config.bot_open_id || "";
    const isLark = account.config.is_lark || false;
    this.apiBase = isLark
      ? "https://open.larksuite.com/open-apis"
      : "https://open.feishu.cn/open-apis";
  }

  private async refreshToken(): Promise<string> {
    if (this.tenantToken && Date.now() / 1000 < this.tokenExpiresAt) {
      return this.tenantToken;
    }
    try {
      const resp = await fetch(
        `${this.apiBase}/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
        }
      );
      const data = await resp.json();
      if (data.code !== 0) {
        console.log(`  ${RED}[feishu] Token error: ${data.msg || "?"}${RESET}`);
        return "";
      }
      this.tenantToken = data.tenant_access_token;
      this.tokenExpiresAt = Date.now() / 1000 + (data.expire || 7200) - 300;
      return this.tenantToken;
    } catch (err: any) {
      console.log(`  ${RED}[feishu] Token error: ${err.message}${RESET}`);
      return "";
    }
  }

  // 用于 webhook 回调解析 (此实现不包含 HTTP server，仅提供解析方法)
  parseEvent(payload: any, token?: string): InboundMessage | null {
    if (this.encryptKey && token && token !== this.encryptKey) {
      console.log(`  ${RED}[feishu] Token verification failed${RESET}`);
      return null;
    }
    if (payload.challenge) {
      printInfo(`[feishu] Challenge: ${payload.challenge}`);
      return null;
    }

    const event = payload.event || {};
    const message = event.message || {};
    const sender = event.sender?.sender_id || {};
    const userId = sender.open_id || sender.user_id || "";
    const chatId = message.chat_id || "";
    const chatType = message.chat_type || "";
    const isGroup = chatType === "group";

    if (isGroup && this.botOpenId && !this.botMentioned(event)) {
      return null;
    }

    const { text, media } = this.parseContent(message);
    if (!text) return null;

    const peerId = chatType === "p2p" ? userId : chatId;
    return {
      text,
      senderId: userId,
      channel: "feishu",
      accountId: this.accountId,
      peerId,
      media,
      isGroup,
      raw: payload,
    };
  }

  private botMentioned(event: any): boolean {
    const mentions = event.message?.mentions || [];
    for (const m of mentions) {
      const id = m.id;
      if (typeof id === "object" && id.open_id === this.botOpenId) return true;
      if (typeof id === "string" && id === this.botOpenId) return true;
      if (m.key === this.botOpenId) return true;
    }
    return false;
  }

  private parseContent(message: any): { text: string; media: any[] } {
    const msgType = message.msg_type || "text";
    let raw = message.content;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = {};
      }
    }
    const content = raw || {};
    const media: any[] = [];

    if (msgType === "text") {
      return { text: content.text || "", media };
    }
    if (msgType === "post") {
      const texts: string[] = [];
      for (const lc of Object.values(content)) {
        if (typeof lc !== "object" || !lc) continue;
        const lcObj = lc as any;
        if (lcObj.title) texts.push(lcObj.title);
        for (const para of lcObj.content || []) {
          for (const node of para) {
            if (node.tag === "text") texts.push(node.text || "");
            else if (node.tag === "a")
              texts.push((node.text || "") + " " + (node.href || ""));
          }
        }
      }
      return { text: texts.join("\n"), media };
    }
    if (msgType === "image") {
      const key = content.image_key;
      if (key) media.push({ type: "image", key });
      return { text: "[image]", media };
    }
    return { text: "", media };
  }

  async receive(): Promise<InboundMessage | null> {
    // 飞书通过 webhook 被动接收，轮询返回 null
    return null;
  }

  async send(to: string, text: string, kwargs?: any): Promise<boolean> {
    const token = await this.refreshToken();
    if (!token) return false;
    try {
      const resp = await fetch(
        `${this.apiBase}/im/v1/messages?receive_id_type=chat_id`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            receive_id: to,
            msg_type: "text",
            content: JSON.stringify({ text }),
          }),
        }
      );
      const data = await resp.json();
      if (data.code !== 0) {
        console.log(`  ${RED}[feishu] Send: ${data.msg || "?"}${RESET}`);
        return false;
      }
      return true;
    } catch (err: any) {
      console.log(`  ${RED}[feishu] Send: ${err.message}${RESET}`);
      return false;
    }
  }

  close(): void {}
}

// ---------------------------------------------------------------------------
// 工具实现 (memory)
// ---------------------------------------------------------------------------
const MEMORY_FILE = path.join(WORKSPACE_DIR, "MEMORY.md");

async function toolMemoryWrite(content: string): Promise<string> {
  printTool("memory_write", `${content.length} chars`);
  try {
    await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    await fs.appendFile(MEMORY_FILE, `\n- ${content}\n`, "utf-8");
    return `Written to memory: ${content.slice(0, 80)}...`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

async function toolMemorySearch(query: string): Promise<string> {
  printTool("memory_search", query);
  try {
    if (!existsSync(MEMORY_FILE)) {
      return "Memory file is empty.";
    }
    const lines = (await fs.readFile(MEMORY_FILE, "utf-8")).split("\n");
    const matches = lines.filter((l) =>
      l.toLowerCase().includes(query.toLowerCase())
    );
    return matches.length
      ? matches.slice(0, 20).join("\n")
      : `No matches for '${query}'.`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// Zod schemas
const MemoryWriteInput = z.object({
  content: z.string().describe("The text to remember."),
});
const MemorySearchInput = z.object({
  query: z.string().describe("Search keyword."),
});

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Save a note to long-term memory.",
      parameters: MemoryWriteInput.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Search through saved memory notes.",
      parameters: MemorySearchInput.toJSONSchema() as any,
    },
  },
];

type ToolHandler = (args: any) => Promise<string>;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  memory_write: (args) => toolMemoryWrite(args.content),
  memory_search: (args) => toolMemorySearch(args.query),
};

async function processToolCall(
  toolName: string,
  toolInput: any
): Promise<string> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return `Error: Unknown tool '${toolName}'`;
  try {
    return await handler(toolInput);
  } catch (err: any) {
    return `Error: ${toolName} failed: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// ChannelManager
// ---------------------------------------------------------------------------
class ChannelManager {
  channels: Map<string, Channel> = new Map();
  accounts: ChannelAccount[] = [];

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
    printChannel(`  [+] Channel registered: ${channel.name}`);
  }

  listChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  closeAll(): void {
    for (const ch of this.channels.values()) {
      ch.close();
    }
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
async function agentLoop() {
  const mgr = new ChannelManager();
  const cli = new CLIChannel();
  mgr.register(cli);

  let tgChannel: TelegramChannel | null = null;
  let tgPollInterval: NodeJS.Timeout | null = null;
  const msgQueue: InboundMessage[] = [];

  const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (tgToken) {
    const tgAcc: ChannelAccount = {
      channel: "telegram",
      accountId: "tg-primary",
      token: tgToken,
      config: { allowed_chats: process.env.TELEGRAM_ALLOWED_CHATS || "" },
    };
    mgr.accounts.push(tgAcc);
    tgChannel = new TelegramChannel(tgAcc);
    mgr.register(tgChannel);
    // 启动轮询
    tgPollInterval = setInterval(async () => {
      if (!tgChannel) return;
      try {
        const msgs = await tgChannel.poll();
        if (msgs.length) msgQueue.push(...msgs);
      } catch (err: any) {
        console.log(`  ${RED}[telegram] Poll error: ${err.message}${RESET}`);
      }
    }, 2000); // 每2秒轮询，也可以采用长轮询但为简化使用间隔
  }

  const fsId = process.env.FEISHU_APP_ID?.trim();
  const fsSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (fsId && fsSecret) {
    const fsAcc: ChannelAccount = {
      channel: "feishu",
      accountId: "feishu-primary",
      token: "",
      config: {
        app_id: fsId,
        app_secret: fsSecret,
        encrypt_key: process.env.FEISHU_ENCRYPT_KEY || "",
        bot_open_id: process.env.FEISHU_BOT_OPEN_ID || "",
        is_lark: ["1", "true"].includes(
          process.env.FEISHU_IS_LARK?.toLowerCase() || ""
        ),
      },
    };
    mgr.accounts.push(fsAcc);
    mgr.register(new FeishuChannel(fsAcc));
  }

  printInfo("=".repeat(60));
  printInfo("  claw0  |  Section 04: Channels");
  printInfo(`  Model: ${MODEL_ID}`);
  printInfo(`  Channels: ${mgr.listChannels().join(", ")}`);
  printInfo("  Commands: /channels /accounts /help  |  quit/exit");
  printInfo("=".repeat(60));
  console.log();

  const conversations: Map<string, ChatCompletionMessageParam[]> = new Map();

  // 辅助函数：处理单个回合
  async function runAgentTurn(inbound: InboundMessage): Promise<void> {
    const sk = buildSessionKey(
      inbound.channel,
      inbound.accountId,
      inbound.peerId
    );
    if (!conversations.has(sk)) conversations.set(sk, []);
    const messages = conversations.get(sk)!;
    messages.push({ role: "user", content: inbound.text });

    if (inbound.channel === "telegram" && tgChannel) {
      await tgChannel.sendTyping(inbound.peerId.split(":topic:")[0]);
    }

    while (true) {
      try {
        const response = await openai.chat.completions.create({
          model: MODEL_ID,
          max_tokens: 8096,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
          tools: TOOLS,
          tool_choice: "auto",
        });

        const choice = response.choices[0];
        messages.push(choice.message);

        if (choice.finish_reason === "stop") {
          const text = choice.message.content || "";
          if (text) {
            const ch = mgr.get(inbound.channel);
            if (ch) await ch.send(inbound.peerId, text);
            else printAssistant(text, inbound.channel);
          }
          break;
        } else if (choice.finish_reason === "tool_calls") {
          const toolCalls = choice.message.tool_calls || [];
          const toolMessages: ChatCompletionMessageParam[] = [];
          for (const tc of toolCalls) {
            if (tc.type !== "function") continue;
            const args = JSON.parse(tc.function.arguments);
            const result = await processToolCall(tc.function.name, args);
            toolMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
          }
          messages.push(...toolMessages);
          continue;
        } else {
          const text = choice.message.content || "";
          if (text) {
            const ch = mgr.get(inbound.channel);
            if (ch) await ch.send(inbound.peerId, text);
          }
          break;
        }
      } catch (err: any) {
        console.error(`\n${YELLOW}API Error: ${err.message}${RESET}\n`);
        while (
          messages.length &&
          messages[messages.length - 1].role !== "user"
        ) {
          messages.pop();
        }
        if (messages.length) messages.pop();
        return;
      }
    }
  }

  // 主循环：处理队列消息和 CLI 输入
  // 使用异步迭代，通过 setImmediate/setTimeout 让出事件循环
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (query: string): Promise<string> => {
    return new Promise((resolve) => rl.question(query, resolve));
  };

  while (true) {
    // 处理 Telegram 队列中的消息
    while (msgQueue.length > 0) {
      const msg = msgQueue.shift()!;
      printChannel(`\n  [telegram] ${msg.senderId}: ${msg.text.slice(0, 80)}`);
      await runAgentTurn(msg);
    }

    // 检查是否有 CLI 输入（非阻塞检查）
    // 为简化，采用超时轮询 stdin，但 readline 是阻塞的，因此我们使用异步提问并在没有 Telegram 时正常等待
    let userInput = "";
    if (tgChannel) {
      // 如果 Telegram 活跃，设置一个短暂的超时，避免阻塞 Telegram 处理
      const inputPromise = askQuestion(`${CYAN}${BOLD}You > ${RESET}`);
      const timeoutPromise = new Promise<string>((resolve) =>
        setTimeout(() => resolve(""), 500)
      );
      userInput = (await Promise.race([inputPromise, timeoutPromise])).trim();
      if (!userInput) continue; // 超时，继续循环处理 Telegram
    } else {
      userInput = (await askQuestion(`${CYAN}${BOLD}You > ${RESET}`)).trim();
    }

    if (!userInput) continue;

    if (
      userInput.toLowerCase() === "quit" ||
      userInput.toLowerCase() === "exit"
    ) {
      break;
    }

    if (userInput.startsWith("/")) {
      const cmd = userInput.trim().toLowerCase();
      if (cmd === "/channels") {
        for (const name of mgr.listChannels()) printChannel(`  - ${name}`);
      } else if (cmd === "/accounts") {
        for (const acc of mgr.accounts) {
          const masked = acc.token ? acc.token.slice(0, 8) + "..." : "(none)";
          printChannel(`  - ${acc.channel}/${acc.accountId}  token=${masked}`);
        }
      } else if (cmd === "/help" || cmd === "/h") {
        printInfo("  /channels  /accounts  /help  quit/exit");
      }
      continue;
    }

    const cliMsg: InboundMessage = {
      text: userInput,
      senderId: "cli-user",
      channel: "cli",
      accountId: "cli-local",
      peerId: "cli-user",
      isGroup: false,
      media: [],
      raw: {},
    };
    await runAgentTurn(cliMsg);
  }

  console.log(`${DIM}Goodbye.${RESET}`);
  if (tgPollInterval) clearInterval(tgPollInterval);
  mgr.closeAll();
  rl.close();
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  if (!OPENAI_API_KEY) {
    console.error(`${YELLOW}Error: OPENAI_API_KEY not set.${RESET}`);
    process.exit(1);
  }
  await agentLoop();
}

main().catch((err) => {
  console.error(`${YELLOW}Unhandled error: ${err}${RESET}`);
  process.exit(1);
});
