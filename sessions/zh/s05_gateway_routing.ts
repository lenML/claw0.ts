/**
 * Section 05: Gateway & Routing (TypeScript 版本)
 * "每条消息都能找到归宿"
 *
 * Gateway 是消息枢纽: 每条入站消息解析为 (agent_id, session_key)。
 * 路由系统是一个五层绑定表, 从最具体到最通用进行匹配。
 *
 * 运行方法:
 *   npx ts-node s05_gateway_routing.ts
 *
 * 需要在 .env 中配置:
 *   OPENAI_API_KEY=sk-xxxxx
 *   MODEL_ID=gpt-4o
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
import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";

// 可选并发限制库
import pLimit from "p-limit";
const limit = pLimit(4); // 最大并发4个agent请求

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
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
const AGENTS_DIR = path.join(WORKSPACE_DIR, ".agents");

// 确保目录存在
fs.mkdir(WORKSPACE_DIR, { recursive: true }).catch(() => {});
fs.mkdir(AGENTS_DIR, { recursive: true }).catch(() => {});

// ---------------------------------------------------------------------------
// ANSI 颜色
// ---------------------------------------------------------------------------
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";

function printInfo(text: string): void {
  console.log(`${DIM}${text}${RESET}`);
}

// ---------------------------------------------------------------------------
// Agent ID 标准化
// ---------------------------------------------------------------------------
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const DEFAULT_AGENT_ID = "main";

function normalizeAgentId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_AGENT_ID;
  if (VALID_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  const cleaned = trimmed
    .toLowerCase()
    .replace(INVALID_CHARS_RE, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || DEFAULT_AGENT_ID;
}

// ---------------------------------------------------------------------------
// 绑定: 五层路由解析
// ---------------------------------------------------------------------------
class Binding {
  agentId: string;
  tier: number; // 1-5, 越小越具体
  matchKey: string; // "peer_id" | "guild_id" | "account_id" | "channel" | "default"
  matchValue: string;
  priority: number;

  constructor(
    agentId: string,
    tier: number,
    matchKey: string,
    matchValue: string,
    priority: number = 0
  ) {
    this.agentId = normalizeAgentId(agentId);
    this.tier = tier;
    this.matchKey = matchKey;
    this.matchValue = matchValue;
    this.priority = priority;
  }

  display(): string {
    const names: Record<number, string> = {
      1: "peer",
      2: "guild",
      3: "account",
      4: "channel",
      5: "default",
    };
    const label = names[this.tier] || `tier-${this.tier}`;
    return `[${label}] ${this.matchKey}=${this.matchValue} -> agent:${this.agentId} (pri=${this.priority})`;
  }
}

class BindingTable {
  private bindings: Binding[] = [];

  add(binding: Binding): void {
    this.bindings.push(binding);
    this.bindings.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.priority - a.priority;
    });
  }

  remove(agentId: string, matchKey: string, matchValue: string): boolean {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter(
      (b) =>
        !(
          b.agentId === agentId &&
          b.matchKey === matchKey &&
          b.matchValue === matchValue
        )
    );
    return this.bindings.length < before;
  }

  listAll(): Binding[] {
    return [...this.bindings];
  }

  resolve(
    channel: string = "",
    accountId: string = "",
    guildId: string = "",
    peerId: string = ""
  ): [string | null, Binding | null] {
    for (const b of this.bindings) {
      if (b.tier === 1 && b.matchKey === "peer_id") {
        if (b.matchValue.includes(":")) {
          if (b.matchValue === `${channel}:${peerId}`) return [b.agentId, b];
        } else if (b.matchValue === peerId) {
          return [b.agentId, b];
        }
      } else if (
        b.tier === 2 &&
        b.matchKey === "guild_id" &&
        b.matchValue === guildId
      ) {
        return [b.agentId, b];
      } else if (
        b.tier === 3 &&
        b.matchKey === "account_id" &&
        b.matchValue === accountId
      ) {
        return [b.agentId, b];
      } else if (
        b.tier === 4 &&
        b.matchKey === "channel" &&
        b.matchValue === channel
      ) {
        return [b.agentId, b];
      } else if (b.tier === 5 && b.matchKey === "default") {
        return [b.agentId, b];
      }
    }
    return [null, null];
  }
}

// ---------------------------------------------------------------------------
// 会话键构建
// ---------------------------------------------------------------------------
function buildSessionKey(
  agentId: string,
  channel: string = "",
  accountId: string = "",
  peerId: string = "",
  dmScope: string = "per-peer"
): string {
  const aid = normalizeAgentId(agentId);
  const ch = (channel || "unknown").trim().toLowerCase();
  const acc = (accountId || "default").trim().toLowerCase();
  const pid = (peerId || "").trim().toLowerCase();

  if (dmScope === "per-account-channel-peer" && pid) {
    return `agent:${aid}:${ch}:${acc}:direct:${pid}`;
  }
  if (dmScope === "per-channel-peer" && pid) {
    return `agent:${aid}:${ch}:direct:${pid}`;
  }
  if (dmScope === "per-peer" && pid) {
    return `agent:${aid}:direct:${pid}`;
  }
  return `agent:${aid}:main`;
}

// ---------------------------------------------------------------------------
// Agent 配置 & 管理器
// ---------------------------------------------------------------------------
interface AgentConfigData {
  id: string;
  name: string;
  personality?: string;
  model?: string;
  dmScope?: string;
}

class AgentConfig {
  id: string;
  name: string;
  personality: string;
  model: string;
  dmScope: string;

  constructor(data: AgentConfigData) {
    this.id = normalizeAgentId(data.id);
    this.name = data.name;
    this.personality = data.personality || "";
    this.model = data.model || "";
    this.dmScope = data.dmScope || "per-peer";
  }

  get effectiveModel(): string {
    return this.model || MODEL_ID;
  }

  systemPrompt(): string {
    const parts = [`You are ${this.name}.`];
    if (this.personality) {
      parts.push(`Your personality: ${this.personality}`);
    }
    parts.push("Answer questions helpfully and stay in character.");
    return parts.join(" ");
  }
}

class AgentManager {
  private agents: Map<string, AgentConfig> = new Map();
  private agentsBase: string;
  private sessions: Map<string, ChatCompletionMessageParam[]> = new Map();

  constructor(agentsBase?: string) {
    this.agentsBase = agentsBase || AGENTS_DIR;
  }

  register(config: AgentConfig): void {
    const aid = config.id;
    this.agents.set(aid, config);
    // 创建必要目录
    const agentDir = path.join(this.agentsBase, aid);
    const sessionsDir = path.join(agentDir, "sessions");
    const workspaceDir = path.join(WORKSPACE_DIR, `workspace-${aid}`);
    fs.mkdir(sessionsDir, { recursive: true }).catch(() => {});
    fs.mkdir(workspaceDir, { recursive: true }).catch(() => {});
  }

  getAgent(agentId: string): AgentConfig | undefined {
    return this.agents.get(normalizeAgentId(agentId));
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  getSession(sessionKey: string): ChatCompletionMessageParam[] {
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }
    return this.sessions.get(sessionKey)!;
  }

  listSessions(agentId?: string): Record<string, number> {
    const result: Record<string, number> = {};
    const aid = agentId ? normalizeAgentId(agentId) : "";
    for (const [key, msgs] of this.sessions.entries()) {
      if (!aid || key.startsWith(`agent:${aid}:`)) {
        result[key] = msgs.length;
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// 工具实现 (简单文件读取与时间)
// ---------------------------------------------------------------------------
const MAX_TOOL_OUTPUT = 30000;

async function toolReadFile(filePath: string): Promise<string> {
  try {
    const p = path.resolve(filePath);
    if (!existsSync(p)) {
      return `Error: File not found: ${filePath}`;
    }
    const content = await fs.readFile(p, "utf-8");
    if (content.length > MAX_TOOL_OUTPUT) {
      return (
        content.slice(0, MAX_TOOL_OUTPUT) +
        `\n... [truncated, ${content.length} total chars]`
      );
    }
    return content;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

function toolGetCurrentTime(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// Zod schemas
const ReadFileInput = z.object({
  file_path: z.string().describe("Path to the file."),
});
const GetCurrentTimeInput = z.object({});

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file.",
      parameters: ReadFileInput.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date and time in UTC.",
      parameters: GetCurrentTimeInput.toJSONSchema() as any,
    },
  },
];

type ToolHandler = (args: any) => Promise<string> | string;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  read_file: (args) => toolReadFile(args.file_path),
  get_current_time: () => toolGetCurrentTime(),
};

async function processToolCall(name: string, input: any): Promise<string> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return `Error: Unknown tool '${name}'`;
  }
  try {
    return await handler(input);
  } catch (err: any) {
    return `Error: ${name} failed: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Agent 运行器
// ---------------------------------------------------------------------------
interface TypingCallback {
  (agentId: string, typing: boolean): void;
}

async function runAgent(
  mgr: AgentManager,
  agentId: string,
  sessionKey: string,
  userText: string,
  onTyping?: TypingCallback
): Promise<string> {
  const agent = mgr.getAgent(agentId);
  if (!agent) {
    return `Error: agent '${agentId}' not found`;
  }
  const messages = mgr.getSession(sessionKey);
  messages.push({ role: "user", content: userText });

  // 并发限制
  return limit(async () => {
    if (onTyping) onTyping(agentId, true);
    try {
      return await agentLoop(
        agent.effectiveModel,
        agent.systemPrompt(),
        messages
      );
    } finally {
      if (onTyping) onTyping(agentId, false);
    }
  });
}

async function agentLoop(
  model: string,
  system: string,
  messages: ChatCompletionMessageParam[]
): Promise<string> {
  for (let i = 0; i < 15; i++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        max_tokens: 4096,
        messages: [{ role: "system", content: system }, ...messages],
        tools: TOOLS,
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      messages.push(choice.message);

      if (choice.finish_reason === "stop") {
        return choice.message.content || "[no text]";
      } else if (choice.finish_reason === "tool_calls") {
        const toolCalls = choice.message.tool_calls || [];
        const toolMessages: ChatCompletionMessageParam[] = [];
        for (const tc of toolCalls) {
          if (tc.type !== "function") continue;
          const args = JSON.parse(tc.function.arguments);
          console.log(`  ${DIM}[tool: ${tc.function.name}]${RESET}`);
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
        return choice.message.content || `[stop=${choice.finish_reason}]`;
      }
    } catch (err: any) {
      // 回滚 user 消息
      while (messages.length && messages[messages.length - 1].role !== "user") {
        messages.pop();
      }
      if (messages.length) messages.pop();
      return `API Error: ${err.message}`;
    }
  }
  return "[max iterations reached]";
}

// ---------------------------------------------------------------------------
// 路由解析辅助
// ---------------------------------------------------------------------------
function resolveRoute(
  bindings: BindingTable,
  mgr: AgentManager,
  channel: string,
  peerId: string,
  accountId: string = "",
  guildId: string = ""
): [string, string] {
  let [agentId, matched] = bindings.resolve(
    channel,
    accountId,
    guildId,
    peerId
  );
  if (!agentId) {
    agentId = DEFAULT_AGENT_ID;
    console.log(
      `  ${DIM}[route] No binding matched, default: ${agentId}${RESET}`
    );
  } else if (matched) {
    console.log(`  ${DIM}[route] Matched: ${matched.display()}${RESET}`);
  }
  const agent = mgr.getAgent(agentId);
  const dmScope = agent?.dmScope || "per-peer";
  const sk = buildSessionKey(agentId, channel, accountId, peerId, dmScope);
  return [agentId, sk];
}

// ---------------------------------------------------------------------------
// Gateway 服务器 (WebSocket, JSON-RPC 2.0)
// ---------------------------------------------------------------------------
class GatewayServer {
  private mgr: AgentManager;
  private bindings: BindingTable;
  private host: string;
  private port: number;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private startTime: number = 0;
  private running: boolean = false;
  private typingEmitter: EventEmitter = new EventEmitter();

  constructor(
    mgr: AgentManager,
    bindings: BindingTable,
    host: string = "localhost",
    port: number = 8765
  ) {
    this.mgr = mgr;
    this.bindings = bindings;
    this.host = host;
    this.port = port;
  }

  async start(): Promise<void> {
    this.startTime = Date.now() / 1000;
    this.running = true;
    this.wss = new WebSocketServer({ host: this.host, port: this.port });
    console.log(
      `${GREEN}Gateway started ws://${this.host}:${this.port}${RESET}`
    );

    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      ws.on("message", async (data: Buffer) => {
        const resp = await this.dispatch(data.toString());
        if (resp) {
          ws.send(JSON.stringify(resp));
        }
      });
      ws.on("close", () => {
        this.clients.delete(ws);
      });
      ws.on("error", () => {
        this.clients.delete(ws);
      });
    });

    // 监听 typing 事件广播给所有客户端
    this.typingEmitter.on("typing", (agentId: string, typing: boolean) => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        method: "typing",
        params: { agent_id: agentId, typing },
      });
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.running = false;
    }
  }

  private async dispatch(raw: string): Promise<any> {
    let req: any;
    try {
      req = JSON.parse(raw);
    } catch {
      return {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      };
    }
    const rid = req.id;
    const method = req.method;
    const params = req.params || {};

    const methods: Record<string, (p: any) => Promise<any>> = {
      send: this.mSend.bind(this),
      "bindings.set": this.mBindSet.bind(this),
      "bindings.list": this.mBindList.bind(this),
      "sessions.list": this.mSessions.bind(this),
      "agents.list": this.mAgents.bind(this),
      status: this.mStatus.bind(this),
    };

    const handler = methods[method];
    if (!handler) {
      return {
        jsonrpc: "2.0",
        error: { code: -32601, message: `Unknown: ${method}` },
        id: rid,
      };
    }
    try {
      const result = await handler(params);
      return { jsonrpc: "2.0", result, id: rid };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        error: { code: -32000, message: err.message },
        id: rid,
      };
    }
  }

  private async mSend(p: any): Promise<any> {
    const text = p.text;
    if (!text) throw new Error("text is required");
    const channel = p.channel || "websocket";
    const peerId = p.peer_id || "ws-client";
    let agentId: string;
    let sessionKey: string;

    if (p.agent_id) {
      agentId = normalizeAgentId(p.agent_id);
      const agent = this.mgr.getAgent(agentId);
      sessionKey = buildSessionKey(
        agentId,
        channel,
        undefined,
        peerId,
        agent?.dmScope || "per-peer"
      );
    } else {
      [agentId, sessionKey] = resolveRoute(
        this.bindings,
        this.mgr,
        channel,
        peerId
      );
    }

    const reply = await runAgent(
      this.mgr,
      agentId,
      sessionKey,
      text,
      (aid, typing) => {
        this.typingEmitter.emit("typing", aid, typing);
      }
    );
    return { agent_id: agentId, session_key: sessionKey, reply };
  }

  private async mBindSet(p: any): Promise<any> {
    const b = new Binding(
      p.agent_id || "",
      p.tier || 5,
      p.match_key || "default",
      p.match_value || "*",
      p.priority || 0
    );
    this.bindings.add(b);
    return { ok: true, binding: b.display() };
  }

  private async mBindList(p: any): Promise<any[]> {
    return this.bindings.listAll().map((b) => ({
      agent_id: b.agentId,
      tier: b.tier,
      match_key: b.matchKey,
      match_value: b.matchValue,
      priority: b.priority,
    }));
  }

  private async mSessions(p: any): Promise<Record<string, number>> {
    return this.mgr.listSessions(p.agent_id);
  }

  private async mAgents(p: any): Promise<any[]> {
    return this.mgr.listAgents().map((a) => ({
      id: a.id,
      name: a.name,
      model: a.effectiveModel,
      dm_scope: a.dmScope,
      personality: a.personality,
    }));
  }

  private async mStatus(p: any): Promise<any> {
    return {
      running: this.running,
      uptime_seconds:
        Math.round((Date.now() / 1000 - this.startTime) * 10) / 10,
      connected_clients: this.clients.size,
      agent_count: this.mgr.listAgents().length,
      binding_count: this.bindings.listAll().length,
    };
  }
}

// ---------------------------------------------------------------------------
// 演示: 双 agent (luna + sage) + 路由绑定
// ---------------------------------------------------------------------------
function setupDemo(): [AgentManager, BindingTable] {
  const mgr = new AgentManager();
  mgr.register(
    new AgentConfig({
      id: "luna",
      name: "Luna",
      personality:
        "warm, curious, and encouraging. You love asking follow-up questions.",
    })
  );
  mgr.register(
    new AgentConfig({
      id: "sage",
      name: "Sage",
      personality:
        "direct, analytical, and concise. You prefer facts over opinions.",
    })
  );

  const bt = new BindingTable();
  bt.add(new Binding("luna", 5, "default", "*"));
  bt.add(new Binding("sage", 4, "channel", "telegram"));
  bt.add(new Binding("sage", 1, "peer_id", "discord:admin-001", 10));

  return [mgr, bt];
}

// ---------------------------------------------------------------------------
// REPL 命令
// ---------------------------------------------------------------------------
function cmdBindings(bt: BindingTable): void {
  const all = bt.listAll();
  if (all.length === 0) {
    console.log(`  ${DIM}(no bindings)${RESET}`);
    return;
  }
  console.log(`\n${BOLD}Route Bindings (${all.length}):${RESET}`);
  for (const b of all) {
    const color = [MAGENTA, BLUE, CYAN, GREEN, DIM][Math.min(b.tier - 1, 4)];
    console.log(`  ${color}${b.display()}${RESET}`);
  }
  console.log();
}

function cmdRoute(bt: BindingTable, mgr: AgentManager, args: string): void {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    console.log(
      `  ${YELLOW}Usage: /route <channel> <peer_id> [account_id] [guild_id]${RESET}`
    );
    return;
  }
  const ch = parts[0];
  const pid = parts[1];
  const acc = parts[2] || "";
  const gid = parts[3] || "";
  const [aid, sk] = resolveRoute(bt, mgr, ch, pid, acc, gid);
  const a = mgr.getAgent(aid);
  console.log(`\n${BOLD}Route Resolution:${RESET}`);
  console.log(
    `  ${DIM}Input:   ch=${ch} peer=${pid} acc=${acc || "-"} guild=${
      gid || "-"
    }${RESET}`
  );
  console.log(`  ${CYAN}Agent:   ${aid} (${a?.name || "?"})${RESET}`);
  console.log(`  ${GREEN}Session: ${sk}${RESET}\n`);
}

function cmdAgents(mgr: AgentManager): void {
  const agents = mgr.listAgents();
  if (agents.length === 0) {
    console.log(`  ${DIM}(no agents)${RESET}`);
    return;
  }
  console.log(`\n${BOLD}Agents (${agents.length}):${RESET}`);
  for (const a of agents) {
    console.log(
      `  ${CYAN}${a.id}${RESET} (${a.name})  model=${a.effectiveModel}  dm_scope=${a.dmScope}`
    );
    if (a.personality) {
      console.log(
        `    ${DIM}${a.personality.slice(0, 70)}${
          a.personality.length > 70 ? "..." : ""
        }${RESET}`
      );
    }
  }
  console.log();
}

function cmdSessions(mgr: AgentManager): void {
  const sessions = mgr.listSessions();
  if (Object.keys(sessions).length === 0) {
    console.log(`  ${DIM}(no sessions)${RESET}`);
    return;
  }
  console.log(`\n${BOLD}Sessions (${Object.keys(sessions).length}):${RESET}`);
  for (const [k, n] of Object.entries(sessions).sort()) {
    console.log(`  ${GREEN}${k}${RESET} (${n} msgs)`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// REPL 主循环
// ---------------------------------------------------------------------------
async function repl(): Promise<void> {
  const [mgr, bindings] = setupDemo();
  console.log(`${DIM}${"=".repeat(64)}${RESET}`);
  console.log(`${DIM}  claw0  |  Section 05: Gateway & Routing${RESET}`);
  console.log(`${DIM}  Model: ${MODEL_ID}${RESET}`);
  console.log(`${DIM}${"=".repeat(64)}${RESET}`);
  console.log(
    `${DIM}  /bindings  /route <ch> <peer>  /agents  /sessions  /switch <id>  /gateway${RESET}`
  );
  console.log();

  const ch = "cli";
  const pid = "repl-user";
  let forceAgent = "";
  let gwStarted = false;
  let gateway: GatewayServer | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (query: string): Promise<string> => {
    return new Promise((resolve) => rl.question(query, resolve));
  };

  while (true) {
    let userInput = "";
    try {
      userInput = (await askQuestion(`${CYAN}${BOLD}You > ${RESET}`)).trim();
    } catch {
      console.log(`\n${DIM}Goodbye.${RESET}`);
      break;
    }
    if (!userInput) continue;

    if (
      userInput.toLowerCase() === "quit" ||
      userInput.toLowerCase() === "exit"
    ) {
      console.log(`${DIM}Goodbye.${RESET}`);
      break;
    }

    if (userInput.startsWith("/")) {
      const [cmd, ...args] = userInput.split(/\s+/);
      const argsStr = args.join(" ");
      switch (cmd) {
        case "/bindings":
          cmdBindings(bindings);
          break;
        case "/route":
          cmdRoute(bindings, mgr, argsStr);
          break;
        case "/agents":
          cmdAgents(mgr);
          break;
        case "/sessions":
          cmdSessions(mgr);
          break;
        case "/switch":
          if (!argsStr) {
            console.log(`  ${DIM}force=${forceAgent || "(off)"}${RESET}`);
          } else if (argsStr.toLowerCase() === "off") {
            forceAgent = "";
            console.log(`  ${DIM}Routing mode restored.${RESET}`);
          } else {
            const aid = normalizeAgentId(argsStr);
            if (mgr.getAgent(aid)) {
              forceAgent = aid;
              console.log(`  ${GREEN}Forcing: ${aid}${RESET}`);
            } else {
              console.log(`  ${YELLOW}Not found: ${aid}${RESET}`);
            }
          }
          break;
        case "/gateway":
          if (gwStarted) {
            console.log(`  ${DIM}Already running.${RESET}`);
          } else {
            gateway = new GatewayServer(mgr, bindings);
            await gateway.start();
            console.log(
              `${GREEN}Gateway running in background on ws://localhost:8765${RESET}\n`
            );
            gwStarted = true;
          }
          break;
        default:
          console.log(`  ${YELLOW}Unknown: ${cmd}${RESET}`);
      }
      continue;
    }

    let agentId: string;
    let sessionKey: string;
    if (forceAgent) {
      agentId = forceAgent;
      const agent = mgr.getAgent(agentId);
      sessionKey = buildSessionKey(
        agentId,
        ch,
        undefined,
        pid,
        agent?.dmScope || "per-peer"
      );
    } else {
      [agentId, sessionKey] = resolveRoute(bindings, mgr, ch, pid);
    }

    const agent = mgr.getAgent(agentId);
    const name = agent?.name || agentId;
    console.log(`  ${DIM}-> ${name} (${agentId}) | ${sessionKey}${RESET}`);

    try {
      const reply = await runAgent(mgr, agentId, sessionKey, userInput);
      console.log(`\n${GREEN}${BOLD}${name}:${RESET} ${reply}\n`);
    } catch (err: any) {
      console.log(`\n${RED}Error: ${err.message}${RESET}\n`);
    }
  }

  rl.close();
  if (gateway) {
    await gateway.stop();
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (!OPENAI_API_KEY) {
    console.error(`${YELLOW}Error: OPENAI_API_KEY not set.${RESET}`);
    process.exit(1);
  }
  await repl();
}

main().catch((err) => {
  console.error(`${YELLOW}Unhandled error: ${err}${RESET}`);
  process.exit(1);
});
