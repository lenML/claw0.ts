/**
 * Section 03: Sessions & Context Guard (TypeScript 版本)
 * "会话是 JSONL 文件。写入时追加, 读取时重放。过大时进行摘要压缩。"
 *
 * 围绕同一 agent 循环的两层机制:
 *
 *   SessionStore -- JSONL 持久化 (写入时追加, 读取时重放)
 *   ContextGuard -- 三阶段溢出重试:
 *     先正常调用 -> 截断工具结果 -> 压缩历史 (50%) -> 失败
 *
 * 用法:
 *   npx ts-node s03_sessions.ts
 *
 * 需要在 .env 中配置:
 *   OPENAI_API_KEY=sk-xxxxx
 *   OPENAI_BASE_URL=https://api.openai.com/v1   (可选)
 *   MODEL_ID=gpt-4o
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { existsSync } from "node:fs";
import * as crypto from "node:crypto";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
  override: true,
});

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

const SYSTEM_PROMPT = [
  "You are a helpful AI assistant with access to tools.",
  "Use tools to help the user with file and time queries.",
  "Be concise. If a session has prior context, use it.",
].join("\n");

const WORKSPACE_DIR = path.resolve(__dirname, "../../../workspace");

const CONTEXT_SAFE_LIMIT = 180000;

const MAX_TOOL_OUTPUT = 50000;

// ---------------------------------------------------------------------------
// ANSI 颜色
// ---------------------------------------------------------------------------
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";

function coloredPrompt(): string {
  return `${CYAN}${BOLD}You > ${RESET}`;
}

function printAssistant(text: string): void {
  console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${text}\n`);
}

function printTool(name: string, detail: string): void {
  console.log(`  ${DIM}[tool: ${name}] ${detail}${RESET}`);
}

function printInfo(text: string): void {
  console.log(`${DIM}${text}${RESET}`);
}

function printWarn(text: string): void {
  console.log(`${YELLOW}${text}${RESET}`);
}

function printSession(text: string): void {
  console.log(`${MAGENTA}${text}${RESET}`);
}

// ---------------------------------------------------------------------------
// 安全路径辅助函数
// ---------------------------------------------------------------------------
function safePath(raw: string): string {
  const target = path.resolve(WORKSPACE_DIR, raw);
  const resolvedWorkspace = path.resolve(WORKSPACE_DIR);
  if (!target.startsWith(resolvedWorkspace)) {
    throw new Error(`Path traversal blocked: ${raw}`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// SessionStore -- 基于 JSONL 的会话持久化
// ---------------------------------------------------------------------------
interface SessionIndexEntry {
  label: string;
  created_at: string;
  last_active: string;
  message_count: number;
}

interface JsonlRecord {
  type: string;
  content?: any;
  ts?: number;
  tool_use_id?: string;
  name?: string;
  input?: any;
}

class SessionStore {
  agentId: string;
  baseDir: string;
  indexPath: string;
  index: Record<string, SessionIndexEntry>;
  currentSessionId: string | null = null;

  constructor(agentId: string = "claw0") {
    this.agentId = agentId;
    this.baseDir = path.join(
      WORKSPACE_DIR,
      ".sessions",
      "agents",
      agentId,
      "sessions"
    );
    this.indexPath = path.join(path.dirname(this.baseDir), "sessions.json");
    fs.mkdir(this.baseDir, { recursive: true }).catch(() => {});
    this.index = this.loadIndex();
  }

  private loadIndex(): Record<string, SessionIndexEntry> {
    try {
      if (existsSync(this.indexPath)) {
        const data = fsSync.readFileSync(this.indexPath, "utf-8");
        return JSON.parse(data);
      }
    } catch {}
    return {};
  }

  private saveIndex(): void {
    try {
      fsSync.writeFileSync(
        this.indexPath,
        JSON.stringify(this.index, null, 2),
        "utf-8"
      );
    } catch {}
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  createSession(label: string = ""): string {
    const sessionId = crypto.randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    this.index[sessionId] = {
      label,
      created_at: now,
      last_active: now,
      message_count: 0,
    };
    this.saveIndex();
    try {
      fsSync.writeFileSync(this.sessionPath(sessionId), "");
    } catch {}
    this.currentSessionId = sessionId;
    return sessionId;
  }

  loadSession(sessionId: string): ChatCompletionMessageParam[] {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) {
      return [];
    }
    this.currentSessionId = sessionId;
    return this.rebuildHistory(path);
  }

  saveTurn(role: string, content: any): void {
    if (!this.currentSessionId) return;
    this.appendTranscript(this.currentSessionId, {
      type: role,
      content,
      ts: Date.now() / 1000,
    });
  }

  saveToolResult(
    toolCallId: string,
    name: string,
    toolInput: any,
    result: string
  ): void {
    if (!this.currentSessionId) return;
    const ts = Date.now() / 1000;
    this.appendTranscript(this.currentSessionId, {
      type: "tool_use",
      tool_use_id: toolCallId,
      name,
      input: toolInput,
      ts,
    });
    this.appendTranscript(this.currentSessionId, {
      type: "tool_result",
      tool_use_id: toolCallId,
      content: result,
      ts,
    });
  }

  private appendTranscript(sessionId: string, record: JsonlRecord): void {
    const path = this.sessionPath(sessionId);
    try {
      fsSync.appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
    } catch {}
    if (sessionId in this.index) {
      this.index[sessionId].last_active = new Date().toISOString();
      this.index[sessionId].message_count += 1;
      this.saveIndex();
    }
  }

  private rebuildHistory(path: string): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];
    let content = "";
    try {
      content = fsSync.readFileSync(path, "utf-8");
    } catch {
      return messages;
    }
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      let record: JsonlRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const rtype = record.type;

      if (rtype === "user") {
        messages.push({
          role: "user",
          content: record.content,
        });
      } else if (rtype === "assistant") {
        // 存储时 assistant content 可能是字符串或对象数组
        let msgContent: string | any[];
        if (typeof record.content === "string") {
          msgContent = record.content;
        } else {
          // 已经是数组格式
          msgContent = record.content;
        }
        messages.push({
          role: "assistant",
          content: msgContent,
        });
      } else if (rtype === "tool_use") {
        // OpenAI 中 tool_calls 作为 assistant 消息的一部分，需要整合
        const block = {
          id: record.tool_use_id!,
          type: "function" as const,
          function: {
            name: record.name!,
            arguments: JSON.stringify(record.input),
          },
        };
        // 找到或创建最近的 assistant 消息
        if (
          messages.length > 0 &&
          messages[messages.length - 1].role === "assistant"
        ) {
          const lastMsg = messages[messages.length - 1] as any;
          if (!lastMsg.tool_calls) lastMsg.tool_calls = [];
          lastMsg.tool_calls.push(block);
        } else {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [block],
          });
        }
      } else if (rtype === "tool_result") {
        // OpenAI tool 消息
        messages.push({
          role: "tool",
          tool_call_id: record.tool_use_id!,
          content: record.content,
        });
      }
    }
    return messages;
  }

  listSessions(): Array<[string, SessionIndexEntry]> {
    const items = Object.entries(this.index);
    items.sort((a, b) =>
      (b[1].last_active || "").localeCompare(a[1].last_active || "")
    );
    return items;
  }
}

// ---------------------------------------------------------------------------
// 序列化消息用于摘要
// ---------------------------------------------------------------------------
function serializeMessagesForSummary(
  messages: ChatCompletionMessageParam[]
): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;
    if (typeof content === "string") {
      parts.push(`[${role}]: ${content}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string") {
          parts.push(`[${role}]: ${block}`);
        } else if (block.type === "text") {
          parts.push(`[${role}]: ${block.text}`);
        }
      }
    }
    // 处理 tool_calls
    if ("tool_calls" in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.type === "function") {
          parts.push(
            `[${role} called ${tc.function.name}]: ${tc.function.arguments}`
          );
        }
      }
    }
    // tool 结果
    if (role === "tool" && "tool_call_id" in msg) {
      const rc = msg.content;
      const preview =
        typeof rc === "string"
          ? rc.slice(0, 500)
          : JSON.stringify(rc).slice(0, 500);
      parts.push(`[tool_result]: ${preview}`);
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// ContextGuard -- 上下文溢出保护
// ---------------------------------------------------------------------------
class ContextGuard {
  maxTokens: number;

  constructor(maxTokens: number = CONTEXT_SAFE_LIMIT) {
    this.maxTokens = maxTokens;
  }

  estimateTokens(text: string): number {
    return Math.floor(text.length / 4);
  }

  estimateMessagesTokens(messages: ChatCompletionMessageParam[]): number {
    let total = 0;
    for (const msg of messages) {
      const content = msg.content;
      if (typeof content === "string") {
        total += this.estimateTokens(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && "text" in block) {
            total += this.estimateTokens(block.text);
          }
        }
      }
      if ("tool_calls" in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === "function") {
            total += this.estimateTokens(JSON.stringify(tc.function.arguments));
          }
        }
      }
      if (msg.role === "tool" && "content" in msg) {
        const rc = msg.content;
        if (typeof rc === "string") {
          total += this.estimateTokens(rc);
        }
      }
    }
    return total;
  }

  truncateToolResult(result: string, maxFraction: number = 0.3): string {
    const maxChars = Math.floor(this.maxTokens * 4 * maxFraction);
    if (result.length <= maxChars) return result;
    let cut = result.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = maxChars;
    const head = result.slice(0, cut);
    return (
      head +
      `\n\n[... truncated (${result.length} chars total, showing first ${head.length}) ...]`
    );
  }

  async compactHistory(
    messages: ChatCompletionMessageParam[],
    apiClient: OpenAI,
    model: string
  ): Promise<ChatCompletionMessageParam[]> {
    const total = messages.length;
    if (total <= 4) return messages;

    const keepCount = Math.max(4, Math.floor(total * 0.2));
    let compressCount = Math.max(2, Math.floor(total * 0.5));
    compressCount = Math.min(compressCount, total - keepCount);
    if (compressCount < 2) return messages;

    const oldMessages = messages.slice(0, compressCount);
    const recentMessages = messages.slice(compressCount);

    const oldText = serializeMessagesForSummary(oldMessages);

    const summaryPrompt = [
      "Summarize the following conversation concisely, ",
      "preserving key facts and decisions. ",
      "Output only the summary, no preamble.\n\n",
      oldText,
    ].join("");

    let summaryText = "";
    try {
      const summaryResp = await apiClient.chat.completions.create({
        model,
        max_tokens: 2048,
        messages: [{ role: "user", content: summaryPrompt }],
      });
      summaryText = summaryResp.choices[0]?.message?.content || "";
      printSession(
        `  [compact] ${oldMessages.length} messages -> summary (${summaryText.length} chars)`
      );
    } catch (err) {
      printWarn(`  [compact] Summary failed (${err}), dropping old messages`);
      return recentMessages;
    }

    const compacted: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: "[Previous conversation summary]\n" + summaryText,
      },
      {
        role: "assistant",
        content:
          "Understood, I have the context from our previous conversation.",
      },
      ...recentMessages,
    ];
    return compacted;
  }

  private truncateLargeToolResults(
    messages: ChatCompletionMessageParam[]
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];
    for (const msg of messages) {
      if (msg.role === "tool" && typeof msg.content === "string") {
        const truncated = this.truncateToolResult(msg.content);
        result.push({ ...msg, content: truncated });
      } else {
        result.push(msg);
      }
    }
    return result;
  }

  async guardApiCall(
    apiClient: OpenAI,
    model: string,
    system: string,
    messages: ChatCompletionMessageParam[],
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    maxRetries: number = 2
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let currentMessages = messages;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await apiClient.chat.completions.create({
          model,
          max_tokens: 8096,
          messages: [{ role: "system", content: system }, ...currentMessages],
          tools,
          tool_choice: tools ? "auto" : undefined,
        });
        // 成功则更新原数组
        if (currentMessages !== messages) {
          messages.length = 0;
          messages.push(...currentMessages);
        }
        return result;
      } catch (err: any) {
        const errorStr = String(err.message).toLowerCase();
        const isOverflow =
          errorStr.includes("context") || errorStr.includes("token");
        if (!isOverflow || attempt >= maxRetries) {
          throw err;
        }
        if (attempt === 0) {
          printWarn(
            "  [guard] Context overflow detected, truncating large tool results..."
          );
          currentMessages = this.truncateLargeToolResults(currentMessages);
        } else if (attempt === 1) {
          printWarn(
            "  [guard] Still overflowing, compacting conversation history..."
          );
          currentMessages = await this.compactHistory(
            currentMessages,
            apiClient,
            model
          );
        }
      }
    }
    throw new Error("guardApiCall: exhausted retries");
  }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------
async function toolReadFile(filePath: string): Promise<string> {
  printTool("read_file", filePath);
  try {
    const target = safePath(filePath);
    const content = await fs.readFile(target, "utf-8");
    if (content.length > MAX_TOOL_OUTPUT) {
      return (
        content.slice(0, MAX_TOOL_OUTPUT) +
        `\n... [truncated, ${content.length} total chars]`
      );
    }
    return content;
  } catch (err: any) {
    if (err.code === "ENOENT") return `Error: File not found: ${filePath}`;
    return `Error: ${err.message}`;
  }
}

async function toolListDirectory(directory: string = "."): Promise<string> {
  printTool("list_directory", directory);
  try {
    const target = safePath(directory);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const prefix = entry.isDirectory() ? "[dir]  " : "[file] ";
        return prefix + entry.name;
      });
    return lines.length ? lines.join("\n") : "[empty directory]";
  } catch (err: any) {
    if (err.code === "ENOENT")
      return `Error: Directory not found: ${directory}`;
    return `Error: ${err.message}`;
  }
}

function toolGetCurrentTime(): string {
  printTool("get_current_time", "");
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// ---------------------------------------------------------------------------
// 工具 schema (Zod) + 分发表
// ---------------------------------------------------------------------------
const ReadFileInputSchema = z.object({
  file_path: z.string().describe("Path relative to workspace directory."),
});

const ListDirectoryInputSchema = z.object({
  directory: z
    .string()
    .optional()
    .describe("Path relative to workspace directory. Default is root."),
});

const GetCurrentTimeInputSchema = z.object({});

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file under the workspace directory.",
      parameters: ReadFileInputSchema.toJSONSchema(),
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List files and subdirectories in a directory under workspace.",
      parameters: ListDirectoryInputSchema.toJSONSchema(),
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date and time in UTC.",
      parameters: GetCurrentTimeInputSchema.toJSONSchema(),
    },
  },
];

type ToolHandler = (args: any) => Promise<string> | string;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  read_file: (args) => toolReadFile(args.file_path),
  list_directory: (args) => toolListDirectory(args.directory ?? "."),
  get_current_time: () => toolGetCurrentTime(),
};

async function processToolCall(
  toolName: string,
  toolInput: any
): Promise<string> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return `Error: Unknown tool '${toolName}'`;
  }
  try {
    return await handler(toolInput);
  } catch (err: any) {
    return `Error: ${toolName} failed: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// REPL 命令处理
// ---------------------------------------------------------------------------
async function handleReplCommand(
  command: string,
  store: SessionStore,
  guard: ContextGuard,
  messages: ChatCompletionMessageParam[]
): Promise<[boolean, ChatCompletionMessageParam[]]> {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ");

  if (cmd === "/new") {
    const label = arg || "";
    const sid = store.createSession(label);
    printSession(`  Created new session: ${sid}${label ? ` (${label})` : ""}`);
    return [true, []];
  }

  if (cmd === "/list") {
    const sessions = store.listSessions();
    if (sessions.length === 0) {
      printInfo("  No sessions found.");
      return [true, messages];
    }
    printInfo("  Sessions:");
    for (const [sid, meta] of sessions) {
      const active = sid === store.currentSessionId ? " <-- current" : "";
      const labelStr = meta.label ? ` (${meta.label})` : "";
      const last = meta.last_active?.slice(0, 19) || "?";
      printInfo(
        `    ${sid}${labelStr}  msgs=${meta.message_count}  last=${last}${active}`
      );
    }
    return [true, messages];
  }

  if (cmd === "/switch") {
    if (!arg) {
      printWarn("  Usage: /switch <session_id>");
      return [true, messages];
    }
    const targetId = arg.trim();
    const matched = Object.keys(store.index).filter((sid) =>
      sid.startsWith(targetId)
    );
    if (matched.length === 0) {
      printWarn(`  Session not found: ${targetId}`);
      return [true, messages];
    }
    if (matched.length > 1) {
      printWarn(`  Ambiguous prefix, matches: ${matched.join(", ")}`);
      return [true, messages];
    }
    const sid = matched[0];
    const newMessages = store.loadSession(sid);
    printSession(
      `  Switched to session: ${sid} (${newMessages.length} messages)`
    );
    return [true, newMessages];
  }

  if (cmd === "/context") {
    const estimated = guard.estimateMessagesTokens(messages);
    const pct = (estimated / guard.maxTokens) * 100;
    const barLen = 30;
    const filled = Math.floor((barLen * Math.min(pct, 100)) / 100);
    const bar = "#".repeat(filled) + "-".repeat(barLen - filled);
    const color = pct < 50 ? GREEN : pct < 80 ? YELLOW : RED;
    printInfo(
      `  Context usage: ~${estimated.toLocaleString()} / ${guard.maxTokens.toLocaleString()} tokens`
    );
    console.log(`  ${color}[${bar}] ${pct.toFixed(1)}%${RESET}`);
    printInfo(`  Messages: ${messages.length}`);
    return [true, messages];
  }

  if (cmd === "/compact") {
    if (messages.length <= 4) {
      printInfo("  Too few messages to compact (need > 4).");
      return [true, messages];
    }
    printSession("  Compacting history...");
    const newMessages = await guard.compactHistory(messages, openai, MODEL_ID);
    printSession(`  ${messages.length} -> ${newMessages.length} messages`);
    return [true, newMessages];
  }

  if (cmd === "/help") {
    printInfo("  Commands:");
    printInfo("    /new [label]       Create a new session");
    printInfo("    /list              List all sessions");
    printInfo("    /switch <id>       Switch to a session (prefix match)");
    printInfo("    /context           Show context token usage");
    printInfo("    /compact           Manually compact conversation history");
    printInfo("    /help              Show this help");
    printInfo("    quit / exit        Exit the REPL");
    return [true, messages];
  }

  return [false, messages];
}

// ---------------------------------------------------------------------------
// 核心: Agent 循环
// ---------------------------------------------------------------------------
async function agentLoop(): Promise<void> {
  const store = new SessionStore("claw0");
  const guard = new ContextGuard();

  // 恢复最近的会话或创建新会话
  let messages: ChatCompletionMessageParam[] = [];
  const sessions = store.listSessions();
  if (sessions.length > 0) {
    const sid = sessions[0][0];
    messages = store.loadSession(sid);
    printSession(`  Resumed session: ${sid} (${messages.length} messages)`);
  } else {
    const sid = store.createSession("initial");
    printSession(`  Created initial session: ${sid}`);
  }

  printInfo("=".repeat(60));
  printInfo("  claw0  |  Section 03: Sessions & Context Guard");
  printInfo(`  Model: ${MODEL_ID}`);
  printInfo(`  Session: ${store.currentSessionId}`);
  printInfo(`  Tools: ${Object.keys(TOOL_HANDLERS).join(", ")}`);
  printInfo("  Type /help for commands, quit/exit to leave.");
  printInfo("=".repeat(60));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const askQuestion = (query: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(query, resolve);
    });
  };

  while (true) {
    // 获取用户输入
    let userInput: string;
    try {
      userInput = (await askQuestion(coloredPrompt())).trim();
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

    // REPL 命令
    if (userInput.startsWith("/")) {
      const [handled, newMessages] = await handleReplCommand(
        userInput,
        store,
        guard,
        messages
      );
      if (handled) {
        messages = newMessages;
        continue;
      }
    }

    // 追加用户消息
    messages.push({ role: "user", content: userInput });
    store.saveTurn("user", userInput);

    // 内层循环：工具调用链
    while (true) {
      try {
        const response = await guard.guardApiCall(
          openai,
          MODEL_ID,
          SYSTEM_PROMPT,
          messages,
          TOOLS
        );

        const choice = response.choices[0];
        const finishReason = choice.finish_reason;

        // 追加 assistant 消息到历史
        messages.push(choice.message);

        // 保存 assistant 到存储（序列化为可存储格式）
        const serializedContent: any[] = [];
        if (choice.message.content) {
          serializedContent.push({
            type: "text",
            text: choice.message.content,
          });
        }
        if (choice.message.tool_calls) {
          for (const tc of choice.message.tool_calls) {
            if (tc.type === "function") {
              serializedContent.push({
                type: "tool_use",
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments),
              });
            }
          }
        }
        store.saveTurn("assistant", serializedContent);

        if (finishReason === "stop") {
          const assistantText = choice.message.content || "";
          if (assistantText) {
            printAssistant(assistantText);
          }
          break;
        } else if (finishReason === "tool_calls") {
          const toolCalls = choice.message.tool_calls;
          if (!toolCalls || toolCalls.length === 0) {
            printInfo("[tool_calls finish but no tool_calls?]");
            break;
          }

          // 执行工具调用
          const toolMessages: ChatCompletionMessageParam[] = [];
          for (const tc of toolCalls) {
            if (tc.type !== "function") continue;

            const funcName = tc.function.name;
            let args: any = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {}

            const result = await processToolCall(funcName, args);
            store.saveToolResult(tc.id, funcName, args, result);

            toolMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
          }

          messages.push(...toolMessages);
          continue; // 继续内循环
        } else {
          printInfo(`[finish_reason=${finishReason}]`);
          const assistantText = choice.message.content || "";
          if (assistantText) {
            printAssistant(assistantText);
          }
          break;
        }
      } catch (err: any) {
        console.error(`\n${YELLOW}API Error: ${err.message}${RESET}\n`);
        // 回滚到最近的 user 消息
        while (
          messages.length > 0 &&
          messages[messages.length - 1].role !== "user"
        ) {
          messages.pop();
        }
        if (messages.length > 0) messages.pop();
        break;
      }
    }
  }

  rl.close();
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await agentLoop();
}

main().catch((err) => {
  console.error(`${YELLOW}Unhandled error: ${err}${RESET}`);
  process.exit(1);
});
