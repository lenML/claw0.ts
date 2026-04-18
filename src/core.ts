/**
 * core.ts — Unified Agent Framework
 *
 * Consolidates sections 01–07 into a single cohesive implementation:
 *   s01: Agent Loop
 *   s02: Tool Use (bash, read_file, write_file, edit_file)
 *   s03: Sessions & Context Guard
 *   s04: Channels (CLI, Telegram, Feishu)
 *   s05: Gateway & Routing (5-tier binding, WebSocket JSON-RPC)
 *   s06: Intelligence (Soul, Bootstrap, Skills, Memory)
 *   s07: Heartbeat & Cron
 *
 * Usage:
 *   npx ts-node core.ts
 *
 * Environment (.env):
 *   OPENAI_API_KEY=sk-xxxxx
 *   OPENAI_BASE_URL=https://api.openai.com/v1  (optional)
 *   MODEL_ID=gpt-4o
 *   TELEGRAM_BOT_TOKEN=...  (optional)
 *   FEISHU_APP_ID / FEISHU_APP_SECRET  (optional)
 *   WORKSPACE_DIR=./workspace  (optional)
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { existsSync } from "node:fs";
import * as crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { Mutex } from "async-mutex";
import cronParser from "cron-parser";
import pLimit from "p-limit";

const execPromise = promisify(exec);
const limit = pLimit(4);

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

const MODEL_ID = process.env.MODEL_ID || "gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

if (!OPENAI_API_KEY) {
  console.error("\x1b[33mError: OPENAI_API_KEY not set.\x1b[0m");
  console.error(
    "\x1b[2mCopy .env.example to .env and fill in your key.\x1b[0m"
  );
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR || path.resolve(process.cwd(), "workspace");
const AGENTS_DIR = path.join(WORKSPACE_DIR, ".agents");
const STATE_DIR = path.join(WORKSPACE_DIR, ".state");
const CRON_DIR = path.join(WORKSPACE_DIR, "cron");

const CONTEXT_SAFE_LIMIT = 180000;
const MAX_TOOL_OUTPUT = 50000;
const CRON_AUTO_DISABLE_THRESHOLD = 5;

// Ensure base directories
for (const d of [WORKSPACE_DIR, AGENTS_DIR, STATE_DIR, CRON_DIR]) {
  fs.mkdir(d, { recursive: true }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// ANSI Colors & Print Helpers
// ═══════════════════════════════════════════════════════════════════════════

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

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

function printChannel(text: string): void {
  console.log(`${BLUE}${text}${RESET}`);
}

function printHeartbeat(text: string): void {
  console.log(`${BLUE}${BOLD}[heartbeat]${RESET} ${text}`);
}

function printCron(text: string): void {
  console.log(`${MAGENTA}${BOLD}[cron]${RESET} ${text}`);
}

function printSection(title: string): void {
  console.log(`\n${MAGENTA}${BOLD}--- ${title} ---${RESET}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

function safePath(raw: string): string {
  const resolved = path.resolve(WORKSPACE_DIR, raw);
  if (!resolved.startsWith(path.resolve(WORKSPACE_DIR))) {
    throw new Error(`Path traversal blocked: ${raw} resolves outside WORKDIR`);
  }
  return resolved;
}

function truncate(text: string, limit: number = MAX_TOOL_OUTPUT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... [truncated, ${text.length} total chars]`;
}

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

  if (dmScope === "per-account-channel-peer" && pid)
    return `agent:${aid}:${ch}:${acc}:direct:${pid}`;
  if (dmScope === "per-channel-peer" && pid)
    return `agent:${aid}:${ch}:direct:${pid}`;
  if (dmScope === "per-peer" && pid) return `agent:${aid}:direct:${pid}`;
  return `agent:${aid}:main`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SessionStore — JSONL Persistence
// ═══════════════════════════════════════════════════════════════════════════

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

  constructor(agentId: string = "main") {
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
      if (existsSync(this.indexPath))
        return JSON.parse(fsSync.readFileSync(this.indexPath, "utf-8"));
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

  private sessionPath(sid: string): string {
    return path.join(this.baseDir, `${sid}.jsonl`);
  }

  createSession(label: string = ""): string {
    const sid = crypto.randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    this.index[sid] = {
      label,
      created_at: now,
      last_active: now,
      message_count: 0,
    };
    this.saveIndex();
    try {
      fsSync.writeFileSync(this.sessionPath(sid), "");
    } catch {}
    this.currentSessionId = sid;
    return sid;
  }

  loadSession(sid: string): ChatCompletionMessageParam[] {
    const p = this.sessionPath(sid);
    if (!existsSync(p)) return [];
    this.currentSessionId = sid;
    return this.rebuildHistory(p);
  }

  saveTurn(role: string, content: any): void {
    if (!this.currentSessionId) return;
    this.appendRecord(this.currentSessionId, {
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
    this.appendRecord(this.currentSessionId, {
      type: "tool_use",
      tool_use_id: toolCallId,
      name,
      input: toolInput,
      ts,
    });
    this.appendRecord(this.currentSessionId, {
      type: "tool_result",
      tool_use_id: toolCallId,
      content: result,
      ts,
    });
  }

  private appendRecord(sid: string, record: JsonlRecord): void {
    try {
      fsSync.appendFileSync(
        this.sessionPath(sid),
        JSON.stringify(record) + "\n",
        "utf-8"
      );
    } catch {}
    if (sid in this.index) {
      this.index[sid].last_active = new Date().toISOString();
      this.index[sid].message_count += 1;
      this.saveIndex();
    }
  }

  private rebuildHistory(filePath: string): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];
    let content = "";
    try {
      content = fsSync.readFileSync(filePath, "utf-8");
    } catch {
      return messages;
    }

    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      let r: JsonlRecord;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }

      if (r.type === "user") {
        messages.push({ role: "user", content: r.content });
      } else if (r.type === "assistant") {
        messages.push({ role: "assistant", content: r.content });
      } else if (r.type === "tool_use") {
        const block = {
          id: r.tool_use_id!,
          type: "function" as const,
          function: { name: r.name!, arguments: JSON.stringify(r.input) },
        };
        if (
          messages.length > 0 &&
          messages[messages.length - 1].role === "assistant"
        ) {
          const last = messages[messages.length - 1] as any;
          if (!last.tool_calls) last.tool_calls = [];
          last.tool_calls.push(block);
        } else {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [block],
          });
        }
      } else if (r.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: r.tool_use_id!,
          content: r.content,
        });
      }
    }
    return messages;
  }

  listSessions(): Array<[string, SessionIndexEntry]> {
    return Object.entries(this.index).sort((a, b) =>
      (b[1].last_active || "").localeCompare(a[1].last_active || "")
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ContextGuard — Overflow Protection
// ═══════════════════════════════════════════════════════════════════════════

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
      const c = msg.content;
      if (typeof c === "string") total += this.estimateTokens(c);
      else if (Array.isArray(c))
        for (const b of c)
          if (typeof b === "object" && "text" in b)
            total += this.estimateTokens(b.text);
      if ("tool_calls" in msg && msg.tool_calls)
        for (const tc of msg.tool_calls)
          if (tc.type === "function")
            total += this.estimateTokens(JSON.stringify(tc.function.arguments));
      if (msg.role === "tool" && typeof msg.content === "string")
        total += this.estimateTokens(msg.content);
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

  private truncateLargeToolResults(
    messages: ChatCompletionMessageParam[]
  ): ChatCompletionMessageParam[] {
    return messages.map((msg) =>
      msg.role === "tool" && typeof msg.content === "string"
        ? { ...msg, content: this.truncateToolResult(msg.content) }
        : msg
    );
  }

  async compactHistory(
    messages: ChatCompletionMessageParam[],
    model: string = MODEL_ID
  ): Promise<ChatCompletionMessageParam[]> {
    const total = messages.length;
    if (total <= 4) return messages;
    const keepCount = Math.max(4, Math.floor(total * 0.2));
    let compressCount = Math.min(
      Math.max(2, Math.floor(total * 0.5)),
      total - keepCount
    );
    if (compressCount < 2) return messages;

    const oldMsgs = messages.slice(0, compressCount);
    const recentMsgs = messages.slice(compressCount);
    const oldText = serializeMessagesForSummary(oldMsgs);

    let summaryText = "";
    try {
      const resp = await openai.chat.completions.create({
        model,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: "Summarize concisely, preserving key facts:\n\n" + oldText,
          },
        ],
      });
      summaryText = resp.choices[0]?.message?.content || "";
      printSession(
        `  [compact] ${oldMsgs.length} messages -> summary (${summaryText.length} chars)`
      );
    } catch (err) {
      printWarn(`  [compact] Summary failed, dropping old messages`);
      return recentMsgs;
    }

    return [
      {
        role: "user",
        content: "[Previous conversation summary]\n" + summaryText,
      },
      {
        role: "assistant",
        content:
          "Understood, I have the context from our previous conversation.",
      },
      ...recentMsgs,
    ];
  }

  async guardApiCall(
    model: string,
    system: string,
    messages: ChatCompletionMessageParam[],
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    maxRetries: number = 2
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let current = messages;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await openai.chat.completions.create({
          model,
          max_tokens: 8096,
          messages: [{ role: "system", content: system }, ...current],
          tools,
          tool_choice: tools ? "auto" : undefined,
        });
        if (current !== messages) {
          messages.length = 0;
          messages.push(...current);
        }
        return result;
      } catch (err: any) {
        const s = String(err.message).toLowerCase();
        const isOverflow = s.includes("context") || s.includes("token");
        if (!isOverflow || attempt >= maxRetries) throw err;
        if (attempt === 0) {
          printWarn(
            "  [guard] Context overflow, truncating large tool results..."
          );
          current = this.truncateLargeToolResults(current);
        } else {
          printWarn("  [guard] Still overflowing, compacting history...");
          current = await this.compactHistory(current, model);
        }
      }
    }
    throw new Error("guardApiCall: exhausted retries");
  }
}

function serializeMessagesForSummary(
  messages: ChatCompletionMessageParam[]
): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role;
    if (typeof msg.content === "string")
      parts.push(`[${role}]: ${msg.content}`);
    else if (Array.isArray(msg.content))
      for (const b of msg.content)
        if (typeof b === "string") parts.push(`[${role}]: ${b}`);
        else if (b.type === "text") parts.push(`[${role}]: ${b.text}`);
    if ("tool_calls" in msg && msg.tool_calls)
      for (const tc of msg.tool_calls)
        if (tc.type === "function")
          parts.push(
            `[${role} called ${tc.function.name}]: ${tc.function.arguments}`
          );
    if (role === "tool" && "content" in msg) {
      const rc = msg.content;
      parts.push(
        `[tool_result]: ${
          typeof rc === "string"
            ? rc.slice(0, 500)
            : JSON.stringify(rc).slice(0, 500)
        }`
      );
    }
  }
  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryStore — Hybrid Search (TF-IDF + Vector + Temporal + MMR)
// ═══════════════════════════════════════════════════════════════════════════

interface MemoryChunk {
  path: string;
  text: string;
}
interface SearchResult {
  path: string;
  score: number;
  snippet: string;
}

class MemoryStore {
  private memoryDir: string;
  constructor(private workspaceDir: string = WORKSPACE_DIR) {
    this.memoryDir = path.join(workspaceDir, "memory", "daily");
  }

  async writeMemory(
    content: string,
    category: string = "general"
  ): Promise<string> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.memoryDir, `${today}.jsonl`);
    try {
      await fs.appendFile(
        filePath,
        JSON.stringify({ ts: new Date().toISOString(), category, content }) +
          "\n",
        "utf-8"
      );
      return `Memory saved to ${today}.jsonl (${category})`;
    } catch (err: any) {
      return `Error writing memory: ${err.message}`;
    }
  }

  loadEvergreen(): string {
    const p = path.join(this.workspaceDir, "MEMORY.md");
    if (!existsSync(p)) return "";
    try {
      return fsSync.readFileSync(p, "utf-8").trim();
    } catch {
      return "";
    }
  }

  writeEvergreen(content: string): string {
    const p = path.join(this.workspaceDir, "MEMORY.md");
    const existing = this.loadEvergreen();
    fsSync.writeFileSync(
      p,
      existing ? existing + "\n\n" + content.trim() : content.trim(),
      "utf-8"
    );
    return `Memory saved (${content.length} chars)`;
  }

  searchEvergreen(query: string): string {
    const text = this.loadEvergreen();
    if (!text) return "No memories found.";
    const matches = text
      .split("\n")
      .filter((l) => l.toLowerCase().includes(query.toLowerCase()));
    return matches.length
      ? matches.slice(0, 10).join("\n")
      : `No memories matching '${query}'.`;
  }

  private async loadAllChunks(): Promise<MemoryChunk[]> {
    const chunks: MemoryChunk[] = [];
    const evergreen = this.loadEvergreen();
    if (evergreen)
      for (const para of evergreen.split("\n\n")) {
        const t = para.trim();
        if (t) chunks.push({ path: "MEMORY.md", text: t });
      }
    try {
      const files = await fs.readdir(this.memoryDir);
      for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
        const content = await fs.readFile(
          path.join(this.memoryDir, file),
          "utf-8"
        );
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.content)
              chunks.push({
                path: entry.category ? `${file} [${entry.category}]` : file,
                text: entry.content,
              });
          } catch {}
        }
      }
    } catch {}
    return chunks;
  }

  private static tokenize(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) || []).filter(
      (t) => t.length > 1 || (t >= "\u4e00" && t <= "\u9fff")
    );
  }

  async keywordSearch(
    query: string,
    topK = 10
  ): Promise<{ chunk: MemoryChunk; score: number }[]> {
    const chunks = await this.loadAllChunks();
    if (!chunks.length) return [];
    const qTokens = MemoryStore.tokenize(query);
    if (!qTokens.length) return [];
    const chunkTokens = chunks.map((c) => MemoryStore.tokenize(c.text));
    const n = chunks.length;
    const df: Record<string, number> = {};
    for (const tokens of chunkTokens) {
      for (const t of new Set(tokens)) df[t] = (df[t] || 0) + 1;
    }
    const tfidf = (tokens: string[]) => {
      const tf: Record<string, number> = {};
      for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
      const vec: Record<string, number> = {};
      for (const [t, c] of Object.entries(tf))
        vec[t] = c * (Math.log((n + 1) / ((df[t] || 0) + 1)) + 1);
      return vec;
    };
    const cosine = (a: Record<string, number>, b: Record<string, number>) => {
      const common = Object.keys(a).filter((k) => k in b);
      if (!common.length) return 0;
      let dot = 0;
      for (const k of common) dot += a[k] * b[k];
      const na = Math.sqrt(Object.values(a).reduce((s, v) => s + v * v, 0));
      const nb = Math.sqrt(Object.values(b).reduce((s, v) => s + v * v, 0));
      return na && nb ? dot / (na * nb) : 0;
    };
    const qVec = tfidf(qTokens);
    return chunks
      .map((chunk, i) => ({
        chunk,
        score: chunkTokens[i].length ? cosine(qVec, tfidf(chunkTokens[i])) : 0,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private static hashVector(text: string, dim = 64): number[] {
    const tokens = MemoryStore.tokenize(text);
    const vec = new Array(dim).fill(0);
    for (const token of tokens) {
      const hash = crypto.createHash("md5").update(token).digest("hex");
      for (let i = 0; i < dim; i++) {
        const byte = parseInt(hash.slice((i * 2) % 32, (i * 2 + 2) % 32), 16);
        vec[i] += byte & 1 ? 1 : -1;
      }
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  async vectorSearch(
    query: string,
    topK = 10
  ): Promise<{ chunk: MemoryChunk; score: number }[]> {
    const chunks = await this.loadAllChunks();
    if (!chunks.length) return [];
    const qVec = MemoryStore.hashVector(query);
    return chunks
      .map((chunk) => ({
        chunk,
        score: MemoryStore.vCosine(qVec, MemoryStore.hashVector(chunk.text)),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private static vCosine(a: number[], b: number[]): number {
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }

  async hybridSearch(query: string, topK = 5): Promise<SearchResult[]> {
    const chunks = await this.loadAllChunks();
    if (!chunks.length) return [];
    const kw = await this.keywordSearch(query, 10);
    const vs = await this.vectorSearch(query, 10);

    // Merge with weights
    const merged = new Map<string, { chunk: MemoryChunk; score: number }>();
    for (const r of vs) {
      const k = r.chunk.text.slice(0, 100);
      merged.set(k, { chunk: r.chunk, score: r.score * 0.7 });
    }
    for (const r of kw) {
      const k = r.chunk.text.slice(0, 100);
      const ex = merged.get(k);
      if (ex) ex.score += r.score * 0.3;
      else merged.set(k, { chunk: r.chunk, score: r.score * 0.3 });
    }

    // Temporal decay
    const now = new Date();
    const results = Array.from(merged.values()).map((r) => {
      const dm = r.chunk.path.match(/(\d{4}-\d{2}-\d{2})/);
      if (dm) {
        try {
          const ageDays =
            (now.getTime() - new Date(dm[1]).getTime()) / 86400000;
          r.score *= Math.exp(-0.01 * ageDays);
        } catch {}
      }
      return r;
    });

    // MMR reranking
    const tokenized = results.map((r) => MemoryStore.tokenize(r.chunk.text));
    const selected: number[] = [];
    const remaining = new Set(
      Array.from({ length: results.length }, (_, i) => i)
    );
    const reranked: typeof results = [];
    while (remaining.size > 0) {
      let bestIdx = -1,
        bestMMR = -Infinity;
      for (const idx of remaining) {
        const relevance = results[idx].score;
        let maxSim = 0;
        for (const sel of selected) {
          const sA = new Set(tokenized[idx]),
            sB = new Set(tokenized[sel]);
          const inter = [...sA].filter((x) => sB.has(x)).length;
          const sim =
            sA.size + sB.size - inter ? inter / (sA.size + sB.size - inter) : 0;
          if (sim > maxSim) maxSim = sim;
        }
        const mmr = 0.7 * relevance - 0.3 * maxSim;
        if (mmr > bestMMR) {
          bestMMR = mmr;
          bestIdx = idx;
        }
      }
      selected.push(bestIdx);
      remaining.delete(bestIdx);
      reranked.push(results[bestIdx]);
    }

    return reranked.slice(0, topK).map((r) => ({
      path: r.chunk.path,
      score: Math.round(r.score * 10000) / 10000,
      snippet:
        r.chunk.text.length > 200
          ? r.chunk.text.slice(0, 200) + "..."
          : r.chunk.text,
    }));
  }

  async getStats(): Promise<{
    evergreenChars: number;
    dailyFiles: number;
    dailyEntries: number;
  }> {
    const evergreen = this.loadEvergreen();
    let dailyFiles = 0,
      dailyEntries = 0;
    try {
      const files = (await fs.readdir(this.memoryDir)).filter((f) =>
        f.endsWith(".jsonl")
      );
      dailyFiles = files.length;
      for (const f of files)
        dailyEntries += (
          await fs.readFile(path.join(this.memoryDir, f), "utf-8")
        )
          .split("\n")
          .filter((l) => l.trim()).length;
    } catch {}
    return { evergreenChars: evergreen.length, dailyFiles, dailyEntries };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SoulSystem
// ═══════════════════════════════════════════════════════════════════════════

class SoulSystem {
  constructor(private workspace: string = WORKSPACE_DIR) {}

  load(): string {
    const p = path.join(this.workspace, "SOUL.md");
    if (existsSync(p))
      try {
        return fsSync.readFileSync(p, "utf-8").trim();
      } catch {}
    return "You are a helpful AI assistant.";
  }

  buildSystemPrompt(extra: string = ""): string {
    const parts = [this.load()];
    if (extra) parts.push(extra);
    return parts.join("\n\n");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BootstrapLoader
// ═══════════════════════════════════════════════════════════════════════════

const BOOTSTRAP_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "AGENTS.md",
  "MEMORY.md",
];
const MAX_FILE_CHARS = 20000;
const MAX_TOTAL_CHARS = 150000;

class BootstrapLoader {
  constructor(private workspaceDir: string = WORKSPACE_DIR) {}

  async loadFile(name: string): Promise<string> {
    const p = path.join(this.workspaceDir, name);
    if (!existsSync(p)) return "";
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      return "";
    }
  }

  truncateFile(content: string, maxChars: number = MAX_FILE_CHARS): string {
    if (content.length <= maxChars) return content;
    let cut = content.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = maxChars;
    return (
      content.slice(0, cut) +
      `\n\n[... truncated (${content.length} chars total) ...]`
    );
  }

  async loadAll(mode: string = "full"): Promise<Record<string, string>> {
    if (mode === "none") return {};
    const names =
      mode === "minimal" ? ["AGENTS.md", "TOOLS.md"] : [...BOOTSTRAP_FILES];
    const result: Record<string, string> = {};
    let total = 0;
    for (const name of names) {
      const raw = await this.loadFile(name);
      if (!raw) continue;
      let truncated = this.truncateFile(raw);
      if (total + truncated.length > MAX_TOTAL_CHARS) {
        const remaining = MAX_TOTAL_CHARS - total;
        if (remaining > 0) truncated = this.truncateFile(raw, remaining);
        else break;
      }
      result[name] = truncated;
      total += truncated.length;
    }
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SkillsManager
// ═══════════════════════════════════════════════════════════════════════════

interface Skill {
  name: string;
  description: string;
  invocation: string;
  body: string;
  path: string;
}
const MAX_SKILLS = 150;
const MAX_SKILLS_PROMPT = 30000;

class SkillsManager {
  skills: Skill[] = [];
  constructor(private workspaceDir: string = WORKSPACE_DIR) {}

  private parseFrontmatter(text: string): Record<string, string> {
    const meta: Record<string, string> = {};
    if (!text.startsWith("---")) return meta;
    const parts = text.split("---", 3);
    if (parts.length < 3) return meta;
    for (const line of parts[1].trim().split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return meta;
  }

  private async scanDir(base: string): Promise<Skill[]> {
    const found: Skill[] = [];
    try {
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = path.join(base, entry.name, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;
        try {
          const content = await fs.readFile(skillMdPath, "utf-8");
          const meta = this.parseFrontmatter(content);
          if (!meta.name) continue;
          let body = "";
          if (content.startsWith("---")) {
            const p = content.split("---", 3);
            if (p.length >= 3) body = p[2].trim();
          }
          found.push({
            name: meta.name,
            description: meta.description || "",
            invocation: meta.invocation || "",
            body,
            path: path.join(base, entry.name),
          });
        } catch {}
      }
    } catch {}
    return found;
  }

  async discover(extraDirs: string[] = []): Promise<void> {
    const scanOrder = [
      ...extraDirs,
      path.join(this.workspaceDir, "skills"),
      path.join(this.workspaceDir, ".skills"),
      path.join(this.workspaceDir, ".agents", "skills"),
    ];
    const seen = new Map<string, Skill>();
    for (const dir of scanOrder)
      for (const skill of await this.scanDir(dir)) seen.set(skill.name, skill);
    this.skills = Array.from(seen.values()).slice(0, MAX_SKILLS);
  }

  formatPromptBlock(): string {
    if (!this.skills.length) return "";
    const lines = ["## Available Skills", ""];
    let total = 0;
    for (const skill of this.skills) {
      const block = `### Skill: ${skill.name}\nDescription: ${skill.description}\nInvocation: ${skill.invocation}\n\n${skill.body}\n\n`;
      if (total + block.length > MAX_SKILLS_PROMPT) {
        lines.push("(... more skills truncated)");
        break;
      }
      lines.push(block);
      total += block.length;
    }
    return lines.join("\n");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Implementations
// ═══════════════════════════════════════════════════════════════════════════

async function toolBash(
  command: string,
  timeout: number = 30
): Promise<string> {
  const dangerous = ["rm -rf /", "mkfs", "> /dev/sd", "dd if="];
  for (const p of dangerous)
    if (command.includes(p))
      return `Error: Refused dangerous command containing '${p}'`;
  printTool("bash", command);
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: WORKSPACE_DIR,
      timeout: timeout * 1000,
    });
    let output = "";
    if (stdout) output += stdout;
    if (stderr) output += (output ? "\n--- stderr ---\n" : "") + stderr;
    return truncate(output) || "[no output]";
  } catch (error: any) {
    if (error.killed && error.signal === "SIGTERM")
      return `Error: Command timed out after ${timeout}s`;
    let output = error.stdout || "";
    if (error.stderr)
      output += (output ? "\n--- stderr ---\n" : "") + error.stderr;
    if (error.code !== 0) output += `\n[exit code: ${error.code}]`;
    return truncate(output) || `Error: ${error.message}`;
  }
}

async function toolReadFile(filePath: string): Promise<string> {
  printTool("read_file", filePath);
  try {
    const content = await fs.readFile(safePath(filePath), "utf-8");
    return truncate(content);
  } catch (err: any) {
    if (err.code === "ENOENT") return `Error: File not found: ${filePath}`;
    return `Error: ${err.message}`;
  }
}

async function toolWriteFile(
  filePath: string,
  content: string
): Promise<string> {
  printTool("write_file", filePath);
  try {
    const target = safePath(filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
    return `Successfully wrote ${content.length} chars to ${filePath}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

async function toolEditFile(
  filePath: string,
  oldString: string,
  newString: string
): Promise<string> {
  printTool("edit_file", `${filePath} (replace ${oldString.length} chars)`);
  try {
    const target = safePath(filePath);
    const content = await fs.readFile(target, "utf-8");
    const count = content.split(oldString).length - 1;
    if (count === 0)
      return "Error: old_string not found. Make sure it matches exactly.";
    if (count > 1)
      return `Error: old_string found ${count} times. Must be unique.`;
    await fs.writeFile(target, content.replace(oldString, newString), "utf-8");
    return `Successfully edited ${filePath}`;
  } catch (err: any) {
    if (err.code === "ENOENT") return `Error: File not found: ${filePath}`;
    return `Error: ${err.message}`;
  }
}

async function toolListDirectory(directory: string = "."): Promise<string> {
  printTool("list_directory", directory);
  try {
    const entries = await fs.readdir(safePath(directory), {
      withFileTypes: true,
    });
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? "[dir]  " : "[file] ") + e.name);
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

async function toolMemoryWrite(
  content: string,
  category: string = "general"
): Promise<string> {
  printTool("memory_write", `[${category}] ${content.slice(0, 60)}...`);
  return memoryStore.writeMemory(content, category);
}

async function toolMemorySearch(
  query: string,
  topK: number = 5
): Promise<string> {
  printTool("memory_search", query);
  const results = await memoryStore.hybridSearch(query, topK);
  if (!results.length) return "No relevant memories found.";
  return results
    .map((r) => `[${r.path}] (score: ${r.score}) ${r.snippet}`)
    .join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registry — Zod Schemas + Handlers
// ═══════════════════════════════════════════════════════════════════════════

const BashInputSchema = z.object({
  command: z.string().describe("The shell command to execute."),
  timeout: z.number().optional().describe("Timeout in seconds. Default 30."),
});
const ReadFileInputSchema = z.object({
  file_path: z.string().describe("Path relative to workspace directory."),
});
const WriteFileInputSchema = z.object({
  file_path: z.string().describe("Path relative to workspace directory."),
  content: z.string().describe("The content to write."),
});
const EditFileInputSchema = z.object({
  file_path: z.string().describe("Path relative to workspace directory."),
  old_string: z
    .string()
    .describe("The exact text to find and replace. Must be unique."),
  new_string: z.string().describe("The replacement text."),
});
const ListDirectoryInputSchema = z.object({
  directory: z
    .string()
    .optional()
    .describe("Path relative to workspace. Default is root."),
});
const GetCurrentTimeInputSchema = z.object({});
const MemoryWriteInputSchema = z.object({
  content: z.string().describe("The fact or observation to remember."),
  category: z
    .string()
    .optional()
    .describe("Category: preference, fact, context, etc."),
});
const MemorySearchInputSchema = z.object({
  query: z.string().describe("Search query."),
  top_k: z.number().optional().describe("Max results. Default: 5."),
});

const ALL_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command and return its output. Use for system commands, git, package managers, etc.",
      parameters: BashInputSchema.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file under the workspace directory.",
      parameters: ReadFileInputSchema.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file. Creates parent directories if needed. Overwrites existing content.",
      parameters: WriteFileInputSchema.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact string in a file. The old_string must appear exactly once. Always read the file first.",
      parameters: EditFileInputSchema.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List files and subdirectories in a directory under workspace.",
      parameters: ListDirectoryInputSchema.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date and time in UTC.",
      parameters: GetCurrentTimeInputSchema.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Save an important fact or observation to long-term memory.",
      parameters: MemoryWriteInputSchema.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search stored memories for relevant information, ranked by similarity.",
      parameters: MemorySearchInputSchema.toJSONSchema() as any,
    },
  },
];

type ToolHandler = (args: any) => Promise<string> | string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => toolBash(args.command, args.timeout),
  read_file: (args) => toolReadFile(args.file_path),
  write_file: (args) => toolWriteFile(args.file_path, args.content),
  edit_file: (args) =>
    toolEditFile(args.file_path, args.old_string, args.new_string),
  list_directory: (args) => toolListDirectory(args.directory ?? "."),
  get_current_time: () => toolGetCurrentTime(),
  memory_write: (args) => toolMemoryWrite(args.content, args.category),
  memory_search: (args) => toolMemorySearch(args.query, args.top_k),
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

// ═══════════════════════════════════════════════════════════════════════════
// Binding & BindingTable — 5-Tier Routing
// ═══════════════════════════════════════════════════════════════════════════

class Binding {
  agentId: string;
  tier: number;
  matchKey: string;
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
    return `[${names[this.tier] || `tier-${this.tier}`}] ${this.matchKey}=${
      this.matchValue
    } -> agent:${this.agentId} (pri=${this.priority})`;
  }
}

class BindingTable {
  private bindings: Binding[] = [];

  add(b: Binding): void {
    this.bindings.push(b);
    this.bindings.sort((a, b) =>
      a.tier !== b.tier ? a.tier - b.tier : b.priority - a.priority
    );
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
    channel = "",
    accountId = "",
    guildId = "",
    peerId = ""
  ): [string | null, Binding | null] {
    for (const b of this.bindings) {
      if (b.tier === 1 && b.matchKey === "peer_id") {
        if (
          b.matchValue.includes(":")
            ? b.matchValue === `${channel}:${peerId}`
            : b.matchValue === peerId
        )
          return [b.agentId, b];
      } else if (
        b.tier === 2 &&
        b.matchKey === "guild_id" &&
        b.matchValue === guildId
      )
        return [b.agentId, b];
      else if (
        b.tier === 3 &&
        b.matchKey === "account_id" &&
        b.matchValue === accountId
      )
        return [b.agentId, b];
      else if (
        b.tier === 4 &&
        b.matchKey === "channel" &&
        b.matchValue === channel
      )
        return [b.agentId, b];
      else if (b.tier === 5 && b.matchKey === "default") return [b.agentId, b];
    }
    return [null, null];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AgentConfig & AgentManager
// ═══════════════════════════════════════════════════════════════════════════

interface AgentConfigData {
  id: string;
  name: string;
  personality?: string;
  model?: string;
  dmScope?: string;
  tools?: string[]; // which tools this agent can use; empty = all
}

class AgentConfig {
  id: string;
  name: string;
  personality: string;
  model: string;
  dmScope: string;
  tools: string[];

  constructor(data: AgentConfigData) {
    this.id = normalizeAgentId(data.id);
    this.name = data.name;
    this.personality = data.personality || "";
    this.model = data.model || "";
    this.dmScope = data.dmScope || "per-peer";
    this.tools = data.tools || [];
  }

  get effectiveModel(): string {
    return this.model || MODEL_ID;
  }

  getTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    if (!this.tools.length) return ALL_TOOLS;
    return ALL_TOOLS.filter((t) =>
      // @ts-ignore
      this.tools.includes(t.function.name)
    );
  }
}

class AgentManager {
  private agents = new Map<string, AgentConfig>();
  private sessions = new Map<string, ChatCompletionMessageParam[]>();
  private sessionStores = new Map<string, SessionStore>();

  register(config: AgentConfig): void {
    const aid = config.id;
    this.agents.set(aid, config);
    const store = new SessionStore(aid);
    this.sessionStores.set(aid, store);
    for (const d of [
      path.join(AGENTS_DIR, aid, "sessions"),
      path.join(WORKSPACE_DIR, `workspace-${aid}`),
    ])
      fs.mkdir(d, { recursive: true }).catch(() => {});
  }

  getAgent(agentId: string): AgentConfig | undefined {
    return this.agents.get(normalizeAgentId(agentId));
  }
  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  getSession(sessionKey: string): ChatCompletionMessageParam[] {
    if (!this.sessions.has(sessionKey)) this.sessions.set(sessionKey, []);
    return this.sessions.get(sessionKey)!;
  }

  getStore(agentId: string): SessionStore | undefined {
    return this.sessionStores.get(normalizeAgentId(agentId));
  }

  listSessions(agentId?: string): Record<string, number> {
    const result: Record<string, number> = {};
    const aid = agentId ? normalizeAgentId(agentId) : "";
    for (const [key, msgs] of this.sessions.entries())
      if (!aid || key.startsWith(`agent:${aid}:`)) result[key] = msgs.length;
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Channel System
// ═══════════════════════════════════════════════════════════════════════════

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

abstract class Channel {
  abstract name: string;
  abstract receive(): Promise<InboundMessage | null>;
  abstract send(to: string, text: string, kwargs?: any): Promise<boolean>;
  close(): void {}
}

// --- CLI Channel ---

class CLIChannel extends Channel {
  name = "cli";
  accountId = "cli-local";
  private rl: readline.Interface | null = null;

  async receive(): Promise<InboundMessage | null> {
    return new Promise((resolve) => {
      if (!this.rl)
        this.rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
      this.rl.question(coloredPrompt(), (answer) => {
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

  async send(_to: string, text: string): Promise<boolean> {
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

// --- Offset Persistence ---

async function saveOffset(filePath: string, offset: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, String(offset), "utf-8");
}
async function loadOffset(filePath: string): Promise<number> {
  try {
    return parseInt((await fs.readFile(filePath, "utf-8")).trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// --- Telegram Channel ---

class TelegramChannel extends Channel {
  name = "telegram";
  static MAX_MSG_LEN = 4096;
  accountId: string;
  private baseUrl: string;
  private allowedChats: Set<string>;
  private offsetPath: string;
  private offset = 0;
  private seen = new Set<number>();
  private mediaGroups = new Map<string, { ts: number; entries: any[] }>();
  private textBuf = new Map<
    string,
    { text: string; msg: InboundMessage; ts: number }
  >();

  constructor(account: ChannelAccount) {
    super();
    this.accountId = account.accountId;
    this.baseUrl = `https://api.telegram.org/bot${account.token}`;
    this.allowedChats = new Set(
      (account.config.allowed_chats || "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
    );
    this.offsetPath = path.join(
      STATE_DIR,
      "telegram",
      `offset-${this.accountId}.txt`
    );
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
    if (!Array.isArray(result)) return this.flushAll();
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
    return [...this.flushMedia(), ...this.flushText()];
  }

  private bufMedia(msg: any, update: any): void {
    const mgid = msg.media_group_id;
    if (!this.mediaGroups.has(mgid))
      this.mediaGroups.set(mgid, { ts: Date.now() / 1000, entries: [] });
    this.mediaGroups.get(mgid)!.entries.push([msg, update]);
  }

  private flushMedia(): InboundMessage[] {
    const now = Date.now() / 1000;
    const ready: InboundMessage[] = [];
    for (const [mgid, group] of this.mediaGroups.entries()) {
      if (now - group.ts < 0.5) continue;
      this.mediaGroups.delete(mgid);
      const captions: string[] = [];
      const mediaItems: any[] = [];
      for (const [m] of group.entries) {
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
      const inbound = this.parse(group.entries[0][0], group.entries[0][1]);
      if (inbound) {
        inbound.text = captions.join("\n") || "[media group]";
        inbound.media = mediaItems;
        if (
          this.allowedChats.size === 0 ||
          this.allowedChats.has(inbound.peerId)
        )
          ready.push(inbound);
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
    } else this.textBuf.set(key, { text: inbound.text, msg: inbound, ts: now });
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
    const isGroup = chatType === "group" || chatType === "supergroup";
    let peerId: string;
    if (chatType === "private") peerId = userId;
    else if (isGroup && chat.is_forum && msg.message_thread_id != null)
      peerId = `${chatId}:topic:${msg.message_thread_id}`;
    else peerId = chatId;
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

  async send(to: string, text: string): Promise<boolean> {
    let chatId = to,
      threadId: number | undefined;
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
      if (!res || !Object.keys(res).length) ok = false;
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
}

// --- Feishu Channel ---

class FeishuChannel extends Channel {
  name = "feishu";
  accountId: string;
  private appId: string;
  private appSecret: string;
  private encryptKey: string;
  private botOpenId: string;
  private apiBase: string;
  private tenantToken = "";
  private tokenExpiresAt = 0;

  constructor(account: ChannelAccount) {
    super();
    this.accountId = account.accountId;
    this.appId = account.config.app_id || "";
    this.appSecret = account.config.app_secret || "";
    this.encryptKey = account.config.encrypt_key || "";
    this.botOpenId = account.config.bot_open_id || "";
    this.apiBase = account.config.is_lark
      ? "https://open.larksuite.com/open-apis"
      : "https://open.feishu.cn/open-apis";
  }

  private async refreshToken(): Promise<string> {
    if (this.tenantToken && Date.now() / 1000 < this.tokenExpiresAt)
      return this.tenantToken;
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
        console.log(`  ${RED}[feishu] Token error: ${data.msg}${RESET}`);
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

  parseEvent(payload: any, token?: string): InboundMessage | null {
    if (this.encryptKey && token && token !== this.encryptKey) return null;
    if (payload.challenge) return null;
    const event = payload.event || {};
    const message = event.message || {};
    const sender = event.sender?.sender_id || {};
    const userId = sender.open_id || sender.user_id || "";
    const chatId = message.chat_id || "";
    const chatType = message.chat_type || "";
    const isGroup = chatType === "group";
    if (isGroup && this.botOpenId && !this.botMentioned(event)) return null;
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
    for (const m of event.message?.mentions || []) {
      const id = m.id;
      if (
        (typeof id === "object" && id.open_id === this.botOpenId) ||
        (typeof id === "string" && id === this.botOpenId) ||
        m.key === this.botOpenId
      )
        return true;
    }
    return false;
  }

  private parseContent(message: any): { text: string; media: any[] } {
    const msgType = message.msg_type || "text";
    let raw = message.content;
    if (typeof raw === "string")
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = {};
      }
    const content = raw || {};
    const media: any[] = [];
    if (msgType === "text") return { text: content.text || "", media };
    if (msgType === "post") {
      const texts: string[] = [];
      for (const lc of Object.values(content)) {
        if (typeof lc !== "object" || !lc) continue;
        const lcObj = lc as any;
        if (lcObj.title) texts.push(lcObj.title);
        for (const para of lcObj.content || [])
          for (const node of para)
            if (node.tag === "text") texts.push(node.text || "");
            else if (node.tag === "a")
              texts.push((node.text || "") + " " + (node.href || ""));
      }
      return { text: texts.join("\n"), media };
    }
    if (msgType === "image") {
      if (content.image_key)
        media.push({ type: "image", key: content.image_key });
      return { text: "[image]", media };
    }
    return { text: "", media };
  }

  async receive(): Promise<InboundMessage | null> {
    return null;
  }

  async send(to: string, text: string): Promise<boolean> {
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
        console.log(`  ${RED}[feishu] Send: ${data.msg}${RESET}`);
        return false;
      }
      return true;
    } catch (err: any) {
      console.log(`  ${RED}[feishu] Send: ${err.message}${RESET}`);
      return false;
    }
  }
}

// --- ChannelManager ---

class ChannelManager {
  channels = new Map<string, Channel>();
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
    for (const ch of this.channels.values()) ch.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GatewayServer — WebSocket JSON-RPC 2.0
// ═══════════════════════════════════════════════════════════════════════════

class GatewayServer {
  private mgr: AgentManager;
  private bindings: BindingTable;
  private host: string;
  private port: number;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private startTime = 0;
  private running = false;
  private typingEmitter = new EventEmitter();

  constructor(
    mgr: AgentManager,
    bindings: BindingTable,
    host = "localhost",
    port = 8765
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
        if (resp) ws.send(JSON.stringify(resp));
      });
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });
    this.typingEmitter.on("typing", (agentId: string, typing: boolean) => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        method: "typing",
        params: { agent_id: agentId, typing },
      });
      for (const c of this.clients)
        if (c.readyState === WebSocket.OPEN) c.send(msg);
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
    const methods: Record<string, (p: any) => Promise<any>> = {
      send: this.mSend.bind(this),
      "bindings.set": this.mBindSet.bind(this),
      "bindings.list": this.mBindList.bind(this),
      "sessions.list": this.mSessions.bind(this),
      "agents.list": this.mAgents.bind(this),
      status: this.mStatus.bind(this),
    };
    const handler = methods[req.method];
    if (!handler)
      return {
        jsonrpc: "2.0",
        error: { code: -32601, message: `Unknown: ${req.method}` },
        id: req.id,
      };
    try {
      return {
        jsonrpc: "2.0",
        result: await handler(req.params || {}),
        id: req.id,
      };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        error: { code: -32000, message: err.message },
        id: req.id,
      };
    }
  }

  private async mSend(p: any): Promise<any> {
    if (!p.text) throw new Error("text is required");
    const channel = p.channel || "websocket";
    const peerId = p.peer_id || "ws-client";
    let agentId: string, sessionKey: string;
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
    const reply = await runAgentTurn(
      this.mgr,
      agentId,
      sessionKey,
      p.text,
      undefined,
      (aid, typing) => this.typingEmitter.emit("typing", aid, typing)
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

  private async mBindList(): Promise<any[]> {
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

  private async mAgents(): Promise<any[]> {
    return this.mgr.listAgents().map((a) => ({
      id: a.id,
      name: a.name,
      model: a.effectiveModel,
      dm_scope: a.dmScope,
      personality: a.personality,
    }));
  }

  private async mStatus(): Promise<any> {
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

function resolveRoute(
  bindings: BindingTable,
  mgr: AgentManager,
  channel: string,
  peerId: string,
  accountId = "",
  guildId = ""
): [string, string] {
  let [agentId, matched] = bindings.resolve(
    channel,
    accountId,
    guildId,
    peerId
  );
  if (!agentId) {
    agentId = DEFAULT_AGENT_ID;
    printInfo(`  [route] No binding matched, default: ${agentId}`);
  } else if (matched) printInfo(`  [route] Matched: ${matched.display()}`);
  const agent = mgr.getAgent(agentId);
  const sk = buildSessionKey(
    agentId,
    channel,
    accountId,
    peerId,
    agent?.dmScope || "per-peer"
  );
  return [agentId, sk];
}

// ═══════════════════════════════════════════════════════════════════════════
// HeartbeatRunner
// ═══════════════════════════════════════════════════════════════════════════

interface HeartbeatStatus {
  enabled: boolean;
  running: boolean;
  shouldRun: boolean;
  reason: string;
  lastRun: string;
  nextIn: string;
  interval: string;
  activeHours: string;
  queueSize: number;
}

class HeartbeatRunner {
  private heartbeatPath: string;
  private laneMutex: Mutex;
  private interval: number;
  private activeHours: [number, number];
  private maxQueueSize: number;
  private lastRunAt = 0;
  private _running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private outputQueue: string[] = [];
  private lastOutput = "";
  private soul: SoulSystem;
  private memory: MemoryStore;

  constructor(
    workspace: string = WORKSPACE_DIR,
    laneMutex: Mutex,
    interval = 1800,
    activeHours: [number, number] = [9, 22],
    maxQueueSize = 10
  ) {
    this.heartbeatPath = path.join(workspace, "HEARTBEAT.md");
    this.laneMutex = laneMutex;
    this.interval = interval;
    this.activeHours = activeHours;
    this.maxQueueSize = maxQueueSize;
    this.soul = new SoulSystem(workspace);
    this.memory = new MemoryStore(workspace);
  }

  private checkShouldRun(): [boolean, string] {
    if (!existsSync(this.heartbeatPath))
      return [false, "HEARTBEAT.md not found"];
    try {
      if (!fsSync.readFileSync(this.heartbeatPath, "utf-8").trim())
        return [false, "HEARTBEAT.md is empty"];
    } catch {
      return [false, "cannot read HEARTBEAT.md"];
    }
    const elapsed = Date.now() / 1000 - this.lastRunAt;
    if (elapsed < this.interval)
      return [
        false,
        `interval not elapsed (${Math.round(
          this.interval - elapsed
        )}s remaining)`,
      ];
    const hour = new Date().getHours();
    const [start, end] = this.activeHours;
    const inHours =
      start <= end ? hour >= start && hour < end : hour >= start || hour < end;
    if (!inHours)
      return [false, `outside active hours (${start}:00-${end}:00)`];
    if (this._running) return [false, "already running"];
    return [true, "all checks passed"];
  }

  private parseResponse(response: string): string | null {
    if (response.includes("HEARTBEAT_OK")) {
      const stripped = response.replace("HEARTBEAT_OK", "").trim();
      return stripped.length > 5 ? stripped : null;
    }
    return response.trim() || null;
  }

  private buildPrompt(): [string, string] {
    const instructions = fsSync
      .readFileSync(this.heartbeatPath, "utf-8")
      .trim();
    const mem = this.memory.loadEvergreen();
    let extra = "";
    if (mem) extra = `## Known Context\n\n${mem}\n\n`;
    extra += `Current time: ${new Date()
      .toISOString()
      .replace("T", " ")
      .slice(0, 19)}`;
    return [instructions, this.soul.buildSystemPrompt(extra)];
  }

  private async execute(): Promise<void> {
    if (this.laneMutex.isLocked()) return;
    const release = await this.laneMutex.acquire();
    this._running = true;
    try {
      const [instructions, sysPrompt] = this.buildPrompt();
      if (!instructions) return;
      const response = await runAgentSingleTurn(instructions, sysPrompt);
      const meaningful = this.parseResponse(response);
      if (meaningful === null || meaningful === this.lastOutput) return;
      this.lastOutput = meaningful;
      this.outputQueue.push(meaningful);
      if (this.outputQueue.length > this.maxQueueSize) this.outputQueue.shift();
    } catch (err: any) {
      this.outputQueue.push(`[heartbeat error: ${err.message}]`);
    } finally {
      this._running = false;
      this.lastRunAt = Date.now() / 1000;
      release();
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const [ok] = this.checkShouldRun();
        if (ok) await this.execute();
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const runLoop = async () => {
      await this.loop();
      if (!this.stopped) this.timer = setTimeout(runLoop, 0);
    };
    this.timer = setTimeout(runLoop, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  drainOutput(): string[] {
    const items = [...this.outputQueue];
    this.outputQueue = [];
    return items;
  }

  async trigger(): Promise<string> {
    if (this.laneMutex.isLocked()) return "main lane occupied, cannot trigger";
    const release = await this.laneMutex.acquire();
    this._running = true;
    try {
      const [instructions, sysPrompt] = this.buildPrompt();
      if (!instructions) return "HEARTBEAT.md is empty";
      const response = await runAgentSingleTurn(instructions, sysPrompt);
      const meaningful = this.parseResponse(response);
      if (meaningful === null) return "HEARTBEAT_OK (nothing to report)";
      if (meaningful === this.lastOutput) return "duplicate content (skipped)";
      this.lastOutput = meaningful;
      this.outputQueue.push(meaningful);
      return `triggered, output queued (${meaningful.length} chars)`;
    } catch (err: any) {
      return `trigger failed: ${err.message}`;
    } finally {
      this._running = false;
      this.lastRunAt = Date.now() / 1000;
      release();
    }
  }

  status(): HeartbeatStatus {
    const now = Date.now() / 1000;
    const elapsed = this.lastRunAt > 0 ? now - this.lastRunAt : null;
    const nextIn =
      elapsed !== null ? Math.max(0, this.interval - elapsed) : this.interval;
    const [ok, reason] = this.checkShouldRun();
    return {
      enabled: existsSync(this.heartbeatPath),
      running: this._running,
      shouldRun: ok,
      reason,
      lastRun:
        this.lastRunAt > 0
          ? new Date(this.lastRunAt * 1000).toISOString()
          : "never",
      nextIn: `${Math.round(nextIn)}s`,
      interval: `${this.interval}s`,
      activeHours: `${this.activeHours[0]}:00-${this.activeHours[1]}:00`,
      queueSize: this.outputQueue.length,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CronService
// ═══════════════════════════════════════════════════════════════════════════

interface CronJobData {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { kind: string; [key: string]: any };
  payload: { kind: string; message?: string; text?: string };
  delete_after_run?: boolean;
}

class CronJob {
  id: string;
  name: string;
  enabled: boolean;
  scheduleKind: string;
  scheduleConfig: any;
  payload: any;
  deleteAfterRun: boolean;
  consecutiveErrors = 0;
  lastRunAt = 0;
  nextRunAt = 0;

  constructor(data: CronJobData) {
    this.id = data.id;
    this.name = data.name;
    this.enabled = data.enabled;
    this.scheduleKind = data.schedule.kind;
    this.scheduleConfig = data.schedule;
    this.payload = data.payload;
    this.deleteAfterRun = data.delete_after_run || false;
  }
}

class CronService {
  private cronFile: string;
  private runLog: string;
  jobs: CronJob[] = [];
  private outputQueue: string[] = [];
  private soul: SoulSystem;

  constructor(workspace: string = WORKSPACE_DIR) {
    this.cronFile = path.join(workspace, "CRON.json");
    this.runLog = path.join(CRON_DIR, "cron-runs.jsonl");
    this.soul = new SoulSystem(workspace);
    this.loadJobs();
  }

  private loadJobs(): void {
    this.jobs = [];
    if (!existsSync(this.cronFile)) return;
    try {
      const raw = JSON.parse(fsSync.readFileSync(this.cronFile, "utf-8"));
      const now = Date.now() / 1000;
      for (const jd of raw.jobs || []) {
        if (!["at", "every", "cron"].includes(jd.schedule?.kind)) continue;
        const job = new CronJob(jd);
        job.nextRunAt = this.computeNext(job, now);
        this.jobs.push(job);
      }
    } catch (err: any) {
      printWarn(`CRON.json load error: ${err.message}`);
    }
  }

  private computeNext(job: CronJob, now: number): number {
    const cfg = job.scheduleConfig;
    if (job.scheduleKind === "at") {
      try {
        const ts = new Date(cfg.at).getTime() / 1000;
        return ts > now ? ts : 0;
      } catch {
        return 0;
      }
    }
    if (job.scheduleKind === "every") {
      const every = cfg.every_seconds || 3600;
      let anchor: number;
      try {
        anchor = new Date(cfg.anchor).getTime() / 1000;
      } catch {
        anchor = now;
      }
      if (now < anchor) return anchor;
      return anchor + (Math.floor((now - anchor) / every) + 1) * every;
    }
    if (job.scheduleKind === "cron") {
      try {
        return (
          cronParser
            .parse(cfg.expr, { currentDate: new Date(now * 1000) })
            .next()
            .getTime() / 1000
        );
      } catch {
        return 0;
      }
    }
    return 0;
  }

  async tick(): Promise<void> {
    const now = Date.now() / 1000;
    const removeIds: string[] = [];
    for (const job of this.jobs) {
      if (!job.enabled || job.nextRunAt <= 0 || now < job.nextRunAt) continue;
      await this.runJob(job, now);
      if (job.deleteAfterRun && job.scheduleKind === "at")
        removeIds.push(job.id);
    }
    if (removeIds.length)
      this.jobs = this.jobs.filter((j) => !removeIds.includes(j.id));
  }

  private async runJob(job: CronJob, now: number): Promise<void> {
    const kind = job.payload.kind;
    let output = "",
      status = "ok",
      error = "";
    try {
      if (kind === "agent_turn") {
        const msg = job.payload.message;
        if (!msg) {
          output = "[empty message]";
          status = "skipped";
        } else
          output = await runAgentSingleTurn(
            msg,
            `You are performing a scheduled background task. Be concise. Current time: ${new Date()
              .toISOString()
              .slice(0, 19)
              .replace("T", " ")}`
          );
      } else if (kind === "system_event") {
        output = job.payload.text || "";
        if (!output) status = "skipped";
      } else {
        output = `[unknown kind: ${kind}]`;
        status = "error";
        error = `unknown kind: ${kind}`;
      }
    } catch (err: any) {
      status = "error";
      error = err.message;
      output = `[cron error: ${err.message}]`;
    }

    job.lastRunAt = now;
    if (status === "error") {
      job.consecutiveErrors++;
      if (job.consecutiveErrors >= CRON_AUTO_DISABLE_THRESHOLD) {
        job.enabled = false;
        const msg = `Job '${job.name}' auto-disabled after ${job.consecutiveErrors} errors: ${error}`;
        console.log(`${RED}${msg}${RESET}`);
        this.outputQueue.push(msg);
      }
    } else job.consecutiveErrors = 0;
    job.nextRunAt = this.computeNext(job, now);

    const entry: any = {
      job_id: job.id,
      run_at: new Date(now * 1000).toISOString(),
      status,
      output_preview: output.slice(0, 200),
    };
    if (error) entry.error = error;
    try {
      await fs.appendFile(this.runLog, JSON.stringify(entry) + "\n", "utf-8");
    } catch {}
    if (output && status !== "skipped")
      this.outputQueue.push(`[${job.name}] ${output}`);
  }

  triggerJob(jobId: string): string {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return `Job '${jobId}' not found`;
    this.runJob(job, Date.now() / 1000);
    return `'${job.name}' triggered (errors=${job.consecutiveErrors})`;
  }

  drainOutput(): string[] {
    const items = [...this.outputQueue];
    this.outputQueue = [];
    return items;
  }

  listJobs(): any[] {
    const now = Date.now() / 1000;
    return this.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      kind: j.scheduleKind,
      errors: j.consecutiveErrors,
      lastRun:
        j.lastRunAt > 0 ? new Date(j.lastRunAt * 1000).toISOString() : "never",
      nextRun:
        j.nextRunAt > 0 ? new Date(j.nextRunAt * 1000).toISOString() : "n/a",
      nextIn: j.nextRunAt > 0 ? Math.round(j.nextRunAt - now) : null,
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Single-turn LLM call (for heartbeat / cron)
// ═══════════════════════════════════════════════════════════════════════════

async function runAgentSingleTurn(
  prompt: string,
  systemPrompt?: string
): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: MODEL_ID,
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content:
            systemPrompt ||
            "You are a helpful assistant performing a background check.",
        },
        { role: "user", content: prompt },
      ],
    });
    return response.choices[0]?.message?.content?.trim() || "";
  } catch (err: any) {
    return `[agent error: ${err.message}]`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// System Prompt Builder (8-layer assembly)
// ═══════════════════════════════════════════════════════════════════════════

function buildSystemPrompt(
  bootstrap: Record<string, string>,
  skillsBlock: string = "",
  memoryContext: string = "",
  agentConfig?: AgentConfig,
  channel: string = "terminal"
): string {
  const sections: string[] = [];

  // Layer 1: Identity
  const identity =
    bootstrap["IDENTITY.md"]?.trim() ||
    (agentConfig
      ? `You are ${agentConfig.name}.`
      : "You are a helpful personal AI assistant.");
  sections.push(identity);

  // Layer 2: Soul / Personality
  const soul =
    bootstrap["SOUL.md"]?.trim() ||
    (agentConfig?.personality
      ? `Your personality: ${agentConfig.personality}`
      : "");
  if (soul) sections.push(`## Personality\n\n${soul}`);

  // Layer 3: Tool Usage Guidelines
  const toolsMd = bootstrap["TOOLS.md"]?.trim();
  if (toolsMd) sections.push(`## Tool Usage Guidelines\n\n${toolsMd}`);

  // Layer 4: Skills
  if (skillsBlock) sections.push(skillsBlock);

  // Layer 5: Memory
  const memParts: string[] = [];
  const memMd = bootstrap["MEMORY.md"]?.trim();
  if (memMd) memParts.push(`### Evergreen Memory\n\n${memMd}`);
  if (memoryContext)
    memParts.push(`### Recalled Memories (auto-searched)\n\n${memoryContext}`);
  if (memParts.length) sections.push("## Memory\n\n" + memParts.join("\n\n"));
  sections.push(
    "## Memory Instructions\n\n" +
      "- Use memory_write to save important user facts and preferences.\n" +
      "- Reference remembered facts naturally in conversation.\n" +
      "- Use memory_search to recall specific past information."
  );

  // Layer 6: Bootstrap context
  for (const name of ["HEARTBEAT.md", "BOOTSTRAP.md", "AGENTS.md", "USER.md"]) {
    const content = bootstrap[name]?.trim();
    if (content) sections.push(`## ${name.replace(".md", "")}\n\n${content}`);
  }

  // Layer 7: Runtime context
  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  sections.push(
    `## Runtime Context\n\n` +
      `- Agent ID: ${agentConfig?.id || "main"}\n- Model: ${
        agentConfig?.effectiveModel || MODEL_ID
      }\n` +
      `- Channel: ${channel}\n- Current time: ${now}`
  );

  // Layer 8: Channel hints
  const hints: Record<string, string> = {
    terminal: "You are responding via a terminal REPL. Markdown is supported.",
    telegram: "You are responding via Telegram. Keep messages concise.",
    discord:
      "You are responding via Discord. Keep messages under 2000 characters.",
    slack: "You are responding via Slack. Use Slack mrkdwn formatting.",
    cli: "You are responding via a terminal REPL. Markdown is supported.",
  };
  sections.push(
    `## Channel\n\n${hints[channel] || `You are responding via ${channel}.`}`
  );

  return sections.join("\n\n");
}

async function autoRecall(userMessage: string): Promise<string> {
  const results = await memoryStore.hybridSearch(userMessage, 3);
  if (!results.length) return "";
  return results.map((r) => `- [${r.path}] ${r.snippet}`).join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Agent Turn Runner
// ═══════════════════════════════════════════════════════════════════════════

const contextGuard = new ContextGuard();
const memoryStore = new MemoryStore();
const bootstrapLoader = new BootstrapLoader();
const skillsManager = new SkillsManager();

interface TypingCallback {
  (agentId: string, typing: boolean): void;
}

async function runAgentTurn(
  mgr: AgentManager,
  agentId: string,
  sessionKey: string,
  userText: string,
  channel?: Channel,
  onTyping?: TypingCallback
): Promise<string> {
  const agent = mgr.getAgent(agentId);
  if (!agent) return `Error: agent '${agentId}' not found`;

  const messages = mgr.getSession(sessionKey);
  messages.push({ role: "user", content: userText });

  return limit(async () => {
    if (onTyping) onTyping(agentId, true);
    try {
      // Auto-recall memories
      const memoryContext = await autoRecall(userText);

      // Build system prompt
      const bootstrapData = await bootstrapLoader.loadAll("full");
      const skillsBlock = skillsManager.formatPromptBlock();
      const systemPrompt = buildSystemPrompt(
        bootstrapData,
        skillsBlock,
        memoryContext,
        agent,
        channel?.name || "terminal"
      );

      const tools = agent.getTools();

      // Agent inner loop
      for (let i = 0; i < 15; i++) {
        try {
          const response = await contextGuard.guardApiCall(
            agent.effectiveModel,
            systemPrompt,
            messages,
            tools.length ? tools : undefined
          );

          const choice = response.choices[0];
          messages.push(choice.message);

          if (choice.finish_reason === "stop") {
            const text = choice.message.content || "";
            if (text && channel) await channel.send(sessionKey, text);
            else if (text) printAssistant(text);
            return text;
          } else if (choice.finish_reason === "tool_calls") {
            const toolCalls = choice.message.tool_calls || [];
            const toolMessages: ChatCompletionMessageParam[] = [];
            for (const tc of toolCalls) {
              if (tc.type !== "function") continue;
              let args: any = {};
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {}
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
            const text =
              choice.message.content || `[stop=${choice.finish_reason}]`;
            if (text && channel) await channel.send(sessionKey, text);
            return text;
          }
        } catch (err: any) {
          while (
            messages.length &&
            messages[messages.length - 1].role !== "user"
          )
            messages.pop();
          if (messages.length) messages.pop();
          return `API Error: ${err.message}`;
        }
      }
      return "[max iterations reached]";
    } finally {
      if (onTyping) onTyping(agentId, false);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REPL Command Handlers
// ═══════════════════════════════════════════════════════════════════════════

function printReplHelp(): void {
  printInfo("REPL commands:");
  printInfo(
    "  Session:  /new [label]  /list  /switch <id>  /context  /compact"
  );
  printInfo(
    "  Routing:  /bindings  /route <ch> <peer>  /agents  /sessions  /switch-agent <id|off>"
  );
  printInfo(
    "  Intel:    /soul  /skills  /memory  /search <q>  /prompt  /bootstrap"
  );
  printInfo("  Channels: /channels  /accounts");
  printInfo(
    "  Proactive:/heartbeat  /trigger  /cron  /cron-trigger <id>  /lanes"
  );
  printInfo("  Gateway:  /gateway");
  printInfo("  General:  /help  quit / exit");
}

function cmdBindings(bt: BindingTable): void {
  const all = bt.listAll();
  if (!all.length) {
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
    printWarn("  Usage: /route <channel> <peer_id> [account_id] [guild_id]");
    return;
  }
  const [aid, sk] = resolveRoute(
    bt,
    mgr,
    parts[0],
    parts[1],
    parts[2] || "",
    parts[3] || ""
  );
  const a = mgr.getAgent(aid);
  console.log(`\n${BOLD}Route Resolution:${RESET}`);
  console.log(`  ${DIM}Input:   ch=${parts[0]} peer=${parts[1]}${RESET}`);
  console.log(`  ${CYAN}Agent:   ${aid} (${a?.name || "?"})${RESET}`);
  console.log(`  ${GREEN}Session: ${sk}${RESET}\n`);
}

function cmdAgents(mgr: AgentManager): void {
  const agents = mgr.listAgents();
  if (!agents.length) {
    console.log(`  ${DIM}(no agents)${RESET}`);
    return;
  }
  console.log(`\n${BOLD}Agents (${agents.length}):${RESET}`);
  for (const a of agents) {
    console.log(
      `  ${CYAN}${a.id}${RESET} (${a.name})  model=${a.effectiveModel}  dm_scope=${a.dmScope}`
    );
    if (a.personality)
      console.log(
        `    ${DIM}${a.personality.slice(0, 70)}${
          a.personality.length > 70 ? "..." : ""
        }${RESET}`
      );
  }
  console.log();
}

function cmdSessions(mgr: AgentManager): void {
  const sessions = mgr.listSessions();
  if (!Object.keys(sessions).length) {
    console.log(`  ${DIM}(no sessions)${RESET}`);
    return;
  }
  console.log(`\n${BOLD}Sessions (${Object.keys(sessions).length}):${RESET}`);
  for (const [k, n] of Object.entries(sessions).sort())
    console.log(`  ${GREEN}${k}${RESET} (${n} msgs)`);
  console.log();
}

async function cmdSearch(args: string): Promise<void> {
  if (!args) {
    printWarn("  Usage: /search <query>");
    return;
  }
  printSection(`Memory Search: ${args}`);
  const results = await memoryStore.hybridSearch(args);
  if (!results.length) console.log(`${DIM}(no results)${RESET}`);
  else
    for (const r of results) {
      const color = r.score > 0.3 ? GREEN : DIM;
      console.log(`  ${color}[${r.score}]${RESET} ${r.path}`);
      console.log(`    ${r.snippet}`);
    }
}

async function cmdMemoryStats(): Promise<void> {
  printSection("Memory Stats");
  const stats = await memoryStore.getStats();
  console.log(`  Evergreen (MEMORY.md): ${stats.evergreenChars} chars`);
  console.log(`  Daily files: ${stats.dailyFiles}`);
  console.log(`  Daily entries: ${stats.dailyEntries}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main REPL
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // --- Initialize subsystems ---
  const laneMutex = new Mutex();
  const agentMgr = new AgentManager();
  const bindings = new BindingTable();
  const channelMgr = new ChannelManager();

  // Register demo agents
  agentMgr.register(
    new AgentConfig({
      id: "main",
      name: "Assistant",
      personality: "warm, curious, and helpful",
      tools: [],
    })
  );
  agentMgr.register(
    new AgentConfig({
      id: "luna",
      name: "Luna",
      personality:
        "warm, curious, and encouraging. You love asking follow-up questions.",
    })
  );
  agentMgr.register(
    new AgentConfig({
      id: "sage",
      name: "Sage",
      personality:
        "direct, analytical, and concise. You prefer facts over opinions.",
    })
  );

  // Default bindings
  bindings.add(new Binding("main", 5, "default", "*"));
  bindings.add(new Binding("luna", 4, "channel", "cli"));
  bindings.add(new Binding("sage", 4, "channel", "telegram"));

  // CLI channel
  channelMgr.register(new CLIChannel());

  // Telegram channel (optional)
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
    channelMgr.accounts.push(tgAcc);
    tgChannel = new TelegramChannel(tgAcc);
    channelMgr.register(tgChannel);
    tgPollInterval = setInterval(async () => {
      if (!tgChannel) return;
      try {
        const msgs = await tgChannel.poll();
        if (msgs.length) msgQueue.push(...msgs);
      } catch (err: any) {
        console.log(`  ${RED}[telegram] Poll error: ${err.message}${RESET}`);
      }
    }, 2000);
  }

  // Feishu channel (optional)
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
    channelMgr.accounts.push(fsAcc);
    channelMgr.register(new FeishuChannel(fsAcc));
  }

  // Heartbeat & Cron
  const heartbeat = new HeartbeatRunner(
    WORKSPACE_DIR,
    laneMutex,
    parseFloat(process.env.HEARTBEAT_INTERVAL || "1800"),
    [
      parseInt(process.env.HEARTBEAT_ACTIVE_START || "9"),
      parseInt(process.env.HEARTBEAT_ACTIVE_END || "22"),
    ]
  );
  const cronSvc = new CronService(WORKSPACE_DIR);
  heartbeat.start();

  let cronStopped = false;
  const cronLoop = async () => {
    while (!cronStopped) {
      try {
        await cronSvc.tick();
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  cronLoop();

  // Discover skills
  await skillsManager.discover();

  // Gateway (lazy start)
  let gateway: GatewayServer | null = null;
  let gwStarted = false;

  // Force agent override
  let forceAgent = "";

  // --- Banner ---
  const hbStatus = heartbeat.status();
  printInfo("=".repeat(64));
  printInfo("  claw0  |  Unified Agent Framework (s01–s07)");
  printInfo(`  Model: ${MODEL_ID}`);
  printInfo(`  Workspace: ${WORKSPACE_DIR}`);
  printInfo(
    `  Agents: ${agentMgr
      .listAgents()
      .map((a) => a.id)
      .join(", ")}`
  );
  printInfo(`  Channels: ${channelMgr.listChannels().join(", ")}`);
  printInfo(
    `  Heartbeat: ${hbStatus.enabled ? "on" : "off"} (${hbStatus.interval})`
  );
  printInfo(`  Cron jobs: ${cronSvc.jobs.length}`);
  printInfo(`  Skills: ${skillsManager.skills.length}`);
  printInfo("  /help for commands. quit/exit to leave.");
  printInfo("=".repeat(64));
  console.log();

  // --- REPL ---
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const askQuestion = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  const ch = "cli";
  const pid = "repl-user";

  while (true) {
    // Drain background outputs
    for (const msg of heartbeat.drainOutput()) printHeartbeat(msg);
    for (const msg of cronSvc.drainOutput()) printCron(msg);

    // Process Telegram queue
    while (msgQueue.length > 0) {
      const inbound = msgQueue.shift()!;
      printChannel(
        `\n  [telegram] ${inbound.senderId}: ${inbound.text.slice(0, 80)}`
      );
      let [agentId, sessionKey] = resolveRoute(
        bindings,
        agentMgr,
        inbound.channel,
        inbound.peerId
      );
      if (tgChannel)
        await tgChannel.sendTyping(inbound.peerId.split(":topic:")[0]);
      const tgCh = channelMgr.get("telegram");
      try {
        const reply = await runAgentTurn(
          agentMgr,
          agentId,
          sessionKey,
          inbound.text,
          tgCh || undefined
        );
        console.log(
          `  ${GREEN}[telegram reply]${RESET} ${reply.slice(0, 100)}...`
        );
      } catch (err: any) {
        console.log(`  ${RED}Error: ${err.message}${RESET}`);
      }
    }

    // Get user input
    let userInput: string;
    try {
      if (tgChannel) {
        const inputP = askQuestion(coloredPrompt());
        const timeoutP = new Promise<string>((r) =>
          setTimeout(() => r(""), 500)
        );
        userInput = (await Promise.race([inputP, timeoutP])).trim();
        if (!userInput) continue;
      } else {
        userInput = (await askQuestion(coloredPrompt())).trim();
      }
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

    // --- REPL commands ---
    if (userInput.startsWith("/")) {
      const parts = userInput.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(" ");

      switch (cmd) {
        // Session commands
        case "/new": {
          const store =
            agentMgr.getStore(forceAgent || "main") ||
            new SessionStore(forceAgent || "main");
          const sid = store.createSession(arg);
          printSession(`  Created session: ${sid}${arg ? ` (${arg})` : ""}`);
          break;
        }
        case "/list": {
          const store =
            agentMgr.getStore(forceAgent || "main") ||
            new SessionStore(forceAgent || "main");
          const sessions = store.listSessions();
          if (!sessions.length) {
            printInfo("  No sessions found.");
            break;
          }
          for (const [sid, meta] of sessions) {
            const active = sid === store.currentSessionId ? " <-- current" : "";
            printInfo(
              `    ${sid}${meta.label ? ` (${meta.label})` : ""}  msgs=${
                meta.message_count
              }  last=${(meta.last_active || "?").slice(0, 19)}${active}`
            );
          }
          break;
        }
        case "/context": {
          // Show context usage for current session
          const sessionKey = buildSessionKey(
            forceAgent || "main",
            ch,
            undefined,
            pid
          );
          const msgs = agentMgr.getSession(sessionKey);
          const estimated = contextGuard.estimateMessagesTokens(msgs);
          const pct = (estimated / contextGuard.maxTokens) * 100;
          const barLen = 30;
          const filled = Math.floor((barLen * Math.min(pct, 100)) / 100);
          const bar = "#".repeat(filled) + "-".repeat(barLen - filled);
          const color = pct < 50 ? GREEN : pct < 80 ? YELLOW : RED;
          printInfo(
            `  Context: ~${estimated.toLocaleString()} / ${contextGuard.maxTokens.toLocaleString()} tokens`
          );
          console.log(`  ${color}[${bar}] ${pct.toFixed(1)}%${RESET}`);
          break;
        }
        case "/compact": {
          const sk = buildSessionKey(forceAgent || "main", ch, undefined, pid);
          const msgs = agentMgr.getSession(sk);
          if (msgs.length <= 4) {
            printInfo("  Too few messages to compact.");
            break;
          }
          printSession("  Compacting history...");
          const compacted = await contextGuard.compactHistory(msgs);
          printSession(`  ${msgs.length} -> ${compacted.length} messages`);
          msgs.length = 0;
          msgs.push(...compacted);
          break;
        }

        // Routing commands
        case "/bindings":
          cmdBindings(bindings);
          break;
        case "/route":
          cmdRoute(bindings, agentMgr, arg);
          break;
        case "/agents":
          cmdAgents(agentMgr);
          break;
        case "/sessions":
          cmdSessions(agentMgr);
          break;
        case "/switch-agent": {
          if (!arg) {
            printInfo(`  force=${forceAgent || "(off)"}`);
            break;
          }
          if (arg.toLowerCase() === "off") {
            forceAgent = "";
            printInfo("  Routing mode restored.");
            break;
          }
          const aid = normalizeAgentId(arg);
          if (agentMgr.getAgent(aid)) {
            forceAgent = aid;
            console.log(`  ${GREEN}Forcing: ${aid}${RESET}`);
          } else printWarn(`  Not found: ${aid}`);
          break;
        }

        // Intelligence commands
        case "/soul": {
          printSection("SOUL.md");
          const soul = (await bootstrapLoader.loadFile("SOUL.md")).trim();
          console.log(soul || `${DIM}(SOUL.md not found)${RESET}`);
          break;
        }
        case "/skills": {
          printSection("Skills");
          if (!skillsManager.skills.length)
            console.log(`${DIM}(no skills found)${RESET}`);
          else
            for (const s of skillsManager.skills) {
              console.log(
                `  ${BLUE}${s.invocation}${RESET}  ${s.name} - ${s.description}`
              );
              console.log(`    ${DIM}path: ${s.path}${RESET}`);
            }
          break;
        }
        case "/memory":
          await cmdMemoryStats();
          break;
        case "/search":
          await cmdSearch(arg);
          break;
        case "/prompt": {
          printSection("System Prompt");
          const bd = await bootstrapLoader.loadAll("full");
          const sk = skillsManager.formatPromptBlock();
          const mc = await autoRecall("show prompt");
          const prompt = buildSystemPrompt(
            bd,
            sk,
            mc,
            agentMgr.getAgent(forceAgent || "main")
          );
          console.log(
            prompt.length > 3000
              ? prompt.slice(0, 3000) +
                  `\n${DIM}... (${prompt.length - 3000} more chars)${RESET}`
              : prompt
          );
          printInfo(`\n  Total: ${prompt.length} chars`);
          break;
        }
        case "/bootstrap": {
          printSection("Bootstrap Files");
          const bd = await bootstrapLoader.loadAll("full");
          if (!Object.keys(bd).length)
            console.log(`${DIM}(no bootstrap files loaded)${RESET}`);
          else
            for (const [name, content] of Object.entries(bd))
              console.log(`  ${BLUE}${name}${RESET}: ${content.length} chars`);
          const total = Object.values(bd).reduce((s, c) => s + c.length, 0);
          printInfo(`\n  Total: ${total} chars (limit: ${MAX_TOTAL_CHARS})`);
          break;
        }

        // Channel commands
        case "/channels":
          for (const name of channelMgr.listChannels())
            printChannel(`  - ${name}`);
          break;
        case "/accounts":
          for (const acc of channelMgr.accounts) {
            const masked = acc.token ? acc.token.slice(0, 8) + "..." : "(none)";
            printChannel(
              `  - ${acc.channel}/${acc.accountId}  token=${masked}`
            );
          }
          break;

        // Proactive commands
        case "/heartbeat": {
          const status = heartbeat.status();
          for (const [k, v] of Object.entries(status))
            printInfo(`  ${k}: ${v}`);
          break;
        }
        case "/trigger": {
          printInfo(`  ${await heartbeat.trigger()}`);
          for (const m of heartbeat.drainOutput()) printHeartbeat(m);
          break;
        }
        case "/cron": {
          const jobs = cronSvc.listJobs();
          if (!jobs.length) printInfo("No cron jobs.");
          else
            for (const j of jobs) {
              const tag = j.enabled
                ? `${GREEN}ON${RESET}`
                : `${RED}OFF${RESET}`;
              const err = j.errors ? ` ${YELLOW}err:${j.errors}${RESET}` : "";
              const nxt = j.nextIn !== null ? ` in ${j.nextIn}s` : "";
              console.log(`  [${tag}] ${j.id} - ${j.name}${err}${nxt}`);
            }
          break;
        }
        case "/cron-trigger": {
          if (!arg) printWarn("Usage: /cron-trigger <job_id>");
          else {
            printInfo(`  ${cronSvc.triggerJob(arg)}`);
            for (const m of cronSvc.drainOutput()) printCron(m);
          }
          break;
        }
        case "/lanes":
          printInfo(
            `  main_locked: ${laneMutex.isLocked()}  heartbeat_running: ${
              heartbeat.status().running
            }`
          );
          break;

        // Gateway
        case "/gateway":
          if (gwStarted) printInfo("  Already running.");
          else {
            gateway = new GatewayServer(agentMgr, bindings);
            await gateway.start();
            gwStarted = true;
          }
          break;

        case "/help":
          printReplHelp();
          break;
        default:
          printWarn(`  Unknown: ${cmd}. /help for commands.`);
      }
      continue;
    }

    // --- User conversation ---
    let agentId: string, sessionKey: string;
    if (forceAgent) {
      agentId = forceAgent;
      const agent = agentMgr.getAgent(agentId);
      sessionKey = buildSessionKey(
        agentId,
        ch,
        undefined,
        pid,
        agent?.dmScope || "per-peer"
      );
    } else {
      [agentId, sessionKey] = resolveRoute(bindings, agentMgr, ch, pid);
    }

    const agent = agentMgr.getAgent(agentId);
    const name = agent?.name || agentId;
    printInfo(`  -> ${name} (${agentId}) | ${sessionKey}`);

    const release = await laneMutex.acquire();
    try {
      const reply = await runAgentTurn(
        agentMgr,
        agentId,
        sessionKey,
        userInput
      );
      // runAgentTurn already prints or sends via channel
      if (reply) {
        const cliCh = channelMgr.get("cli");
        if (!cliCh) printAssistant(reply);
      }
    } catch (err: any) {
      console.log(`\n${RED}Error: ${err.message}${RESET}\n`);
    } finally {
      release();
    }
  }

  // --- Cleanup ---
  heartbeat.stop();
  cronStopped = true;
  if (tgPollInterval) clearInterval(tgPollInterval);
  channelMgr.closeAll();
  if (gateway) await gateway.stop();
  rl.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry Point
// ═══════════════════════════════════════════════════════════════════════════

main().catch((err) => {
  console.error(`${YELLOW}Unhandled error: ${err}${RESET}`);
  process.exit(1);
});
