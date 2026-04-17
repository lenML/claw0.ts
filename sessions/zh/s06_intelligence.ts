/**
 * Section 06: Intelligence (TypeScript 版本)
 * "赋予灵魂, 教会记忆"
 *
 * 每轮对话前, agent 的"大脑"是如何组装的?
 * 系统提示词由多个层级动态组装:
 *   Identity / 灵魂 / Tools / 技能 / Memory / Bootstrap / Runtime / Channel
 *
 * 用法:
 *   npx ts-node s06_intelligence.ts
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

const WORKSPACE_DIR = path.resolve(__dirname, "../../workspace");

// Bootstrap 文件名
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
const MAX_SKILLS = 150;
const MAX_SKILLS_PROMPT = 30000;

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

function printSection(title: string): void {
  console.log(`\n${MAGENTA}${BOLD}--- ${title} ---${RESET}`);
}

// ---------------------------------------------------------------------------
// 1. Bootstrap 文件加载器
// ---------------------------------------------------------------------------
class BootstrapLoader {
  constructor(private workspaceDir: string) {}

  async loadFile(name: string): Promise<string> {
    const filePath = path.join(this.workspaceDir, name);
    if (!existsSync(filePath)) return "";
    try {
      return await fs.readFile(filePath, "utf-8");
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
      `\n\n[... truncated (${content.length} chars total, showing first ${cut}) ...]`
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
        if (remaining > 0) {
          truncated = this.truncateFile(raw, remaining);
        } else {
          break;
        }
      }
      result[name] = truncated;
      total += truncated.length;
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// 2. 灵魂系统
// ---------------------------------------------------------------------------
async function loadSoul(workspaceDir: string): Promise<string> {
  const soulPath = path.join(workspaceDir, "SOUL.md");
  if (!existsSync(soulPath)) return "";
  try {
    return (await fs.readFile(soulPath, "utf-8")).trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 3. 技能发现与注入
// ---------------------------------------------------------------------------
interface Skill {
  name: string;
  description: string;
  invocation: string;
  body: string;
  path: string;
}

class SkillsManager {
  skills: Skill[] = [];

  constructor(private workspaceDir: string) {}

  private parseFrontmatter(text: string): Record<string, string> {
    const meta: Record<string, string> = {};
    if (!text.startsWith("---")) return meta;
    const parts = text.split("---", 3);
    if (parts.length < 3) return meta;
    const frontmatter = parts[1].trim();
    for (const line of frontmatter.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      meta[key] = value;
    }
    return meta;
  }

  private async scanDir(base: string): Promise<Skill[]> {
    const found: Skill[] = [];
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = path.join(base, entry.name, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;
        try {
          const content = await fs.readFile(skillMdPath, "utf-8");
          const meta = this.parseFrontmatter(content);
          if (!meta.name) continue;
          let body = "";
          if (content.startsWith("---")) {
            const parts = content.split("---", 3);
            if (parts.length >= 3) body = parts[2].trim();
          }
          found.push({
            name: meta.name,
            description: meta.description || "",
            invocation: meta.invocation || "",
            body,
            path: path.join(base, entry.name),
          });
        } catch {
          // 忽略读取错误
        }
      }
    } catch {
      // 目录可能不存在
    }
    return found;
  }

  async discover(extraDirs: string[] = []): Promise<void> {
    const scanOrder: string[] = [
      ...extraDirs,
      path.join(this.workspaceDir, "skills"),
      path.join(this.workspaceDir, ".skills"),
      path.join(this.workspaceDir, ".agents", "skills"),
      path.join(process.cwd(), ".agents", "skills"),
      path.join(process.cwd(), "skills"),
    ];
    const seen: Map<string, Skill> = new Map();
    for (const dir of scanOrder) {
      const skills = await this.scanDir(dir);
      for (const skill of skills) {
        seen.set(skill.name, skill);
      }
    }
    this.skills = Array.from(seen.values()).slice(0, MAX_SKILLS);
  }

  formatPromptBlock(): string {
    if (this.skills.length === 0) return "";
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

// ---------------------------------------------------------------------------
// 4. 记忆系统
// ---------------------------------------------------------------------------
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

  constructor(private workspaceDir: string) {
    this.memoryDir = path.join(workspaceDir, "memory", "daily");
  }

  private async ensureMemoryDir(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
  }

  async writeMemory(
    content: string,
    category: string = "general"
  ): Promise<string> {
    await this.ensureMemoryDir();
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.memoryDir, `${today}.jsonl`);
    const entry = {
      ts: new Date().toISOString(),
      category,
      content,
    };
    try {
      await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
      return `Memory saved to ${today}.jsonl (${category})`;
    } catch (err: any) {
      return `Error writing memory: ${err.message}`;
    }
  }

  async loadEvergreen(): Promise<string> {
    const memPath = path.join(this.workspaceDir, "MEMORY.md");
    if (!existsSync(memPath)) return "";
    try {
      return (await fs.readFile(memPath, "utf-8")).trim();
    } catch {
      return "";
    }
  }

  private async loadAllChunks(): Promise<MemoryChunk[]> {
    const chunks: MemoryChunk[] = [];
    const evergreen = await this.loadEvergreen();
    if (evergreen) {
      for (const para of evergreen.split("\n\n")) {
        const trimmed = para.trim();
        if (trimmed) chunks.push({ path: "MEMORY.md", text: trimmed });
      }
    }
    try {
      const files = await fs.readdir(this.memoryDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(this.memoryDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const text = entry.content;
            if (text) {
              const cat = entry.category || "";
              const label = cat ? `${file} [${cat}]` : file;
              chunks.push({ path: label, text });
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } catch {
      // 目录不存在
    }
    return chunks;
  }

  private static tokenize(text: string): string[] {
    const tokens = text.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) || [];
    return tokens.filter(
      (t) => t.length > 1 || (t >= "\u4e00" && t <= "\u9fff")
    );
  }

  // TF-IDF 搜索
  async keywordSearch(
    query: string,
    topK: number = 10
  ): Promise<{ chunk: MemoryChunk; score: number }[]> {
    const chunks = await this.loadAllChunks();
    if (chunks.length === 0) return [];
    const queryTokens = MemoryStore.tokenize(query);
    if (queryTokens.length === 0) return [];

    const chunkTokens = chunks.map((c) => MemoryStore.tokenize(c.text));
    const n = chunks.length;
    const df: Record<string, number> = {};
    for (const tokens of chunkTokens) {
      const unique = new Set(tokens);
      for (const t of unique) df[t] = (df[t] || 0) + 1;
    }

    const tfidf = (tokens: string[]): Record<string, number> => {
      const tf: Record<string, number> = {};
      for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
      const vec: Record<string, number> = {};
      for (const [t, c] of Object.entries(tf)) {
        vec[t] = c * (Math.log((n + 1) / ((df[t] || 0) + 1)) + 1);
      }
      return vec;
    };

    const cosine = (
      a: Record<string, number>,
      b: Record<string, number>
    ): number => {
      const common = Object.keys(a).filter((k) => k in b);
      if (common.length === 0) return 0;
      let dot = 0;
      for (const k of common) dot += a[k] * b[k];
      const na = Math.sqrt(Object.values(a).reduce((sum, v) => sum + v * v, 0));
      const nb = Math.sqrt(Object.values(b).reduce((sum, v) => sum + v * v, 0));
      return na && nb ? dot / (na * nb) : 0;
    };

    const qvec = tfidf(queryTokens);
    const scored: { chunk: MemoryChunk; score: number }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (chunkTokens[i].length === 0) continue;
      const score = cosine(qvec, tfidf(chunkTokens[i]));
      if (score > 0) {
        scored.push({ chunk: chunks[i], score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // 模拟向量搜索 (哈希投影)
  private static hashVector(text: string, dim: number = 64): number[] {
    const tokens = MemoryStore.tokenize(text);
    const vec = new Array(dim).fill(0);
    for (const token of tokens) {
      // 使用确定性哈希
      const hash = crypto.createHash("md5").update(token).digest("hex");
      for (let i = 0; i < dim; i++) {
        const byte = parseInt(hash.slice((i * 2) % 32, (i * 2 + 2) % 32), 16);
        vec[i] += byte & 1 ? 1 : -1;
      }
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  private static vectorCosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }

  async vectorSearch(
    query: string,
    topK: number = 10
  ): Promise<{ chunk: MemoryChunk; score: number }[]> {
    const chunks = await this.loadAllChunks();
    if (chunks.length === 0) return [];
    const qVec = MemoryStore.hashVector(query);
    const scored = chunks.map((chunk) => ({
      chunk,
      score: MemoryStore.vectorCosine(qVec, MemoryStore.hashVector(chunk.text)),
    }));
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private static mergeHybrid(
    vectorResults: { chunk: MemoryChunk; score: number }[],
    keywordResults: { chunk: MemoryChunk; score: number }[],
    vectorWeight: number = 0.7,
    textWeight: number = 0.3
  ): { chunk: MemoryChunk; score: number }[] {
    const merged = new Map<string, { chunk: MemoryChunk; score: number }>();
    for (const r of vectorResults) {
      const key = r.chunk.text.slice(0, 100);
      merged.set(key, { chunk: r.chunk, score: r.score * vectorWeight });
    }
    for (const r of keywordResults) {
      const key = r.chunk.text.slice(0, 100);
      const existing = merged.get(key);
      if (existing) {
        existing.score += r.score * textWeight;
      } else {
        merged.set(key, { chunk: r.chunk, score: r.score * textWeight });
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.score - a.score);
  }

  private static jaccardSimilarity(
    tokensA: string[],
    tokensB: string[]
  ): number {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    const intersection = [...setA].filter((x) => setB.has(x)).length;
    const union = setA.size + setB.size - intersection;
    return union ? intersection / union : 0;
  }

  private static mmrRerank(
    results: { chunk: MemoryChunk; score: number }[],
    lambda: number = 0.7
  ): { chunk: MemoryChunk; score: number }[] {
    if (results.length <= 1) return results;
    const tokenized = results.map((r) => MemoryStore.tokenize(r.chunk.text));
    const selectedIndices: number[] = [];
    const remaining = new Set(
      Array.from({ length: results.length }, (_, i) => i)
    );
    const reranked: { chunk: MemoryChunk; score: number }[] = [];
    while (remaining.size > 0) {
      let bestIdx = -1;
      let bestMMR = -Infinity;
      for (const idx of remaining) {
        const relevance = results[idx].score;
        let maxSim = 0;
        for (const sel of selectedIndices) {
          const sim = MemoryStore.jaccardSimilarity(
            tokenized[idx],
            tokenized[sel]
          );
          if (sim > maxSim) maxSim = sim;
        }
        const mmr = lambda * relevance - (1 - lambda) * maxSim;
        if (mmr > bestMMR) {
          bestMMR = mmr;
          bestIdx = idx;
        }
      }
      selectedIndices.push(bestIdx);
      remaining.delete(bestIdx);
      reranked.push(results[bestIdx]);
    }
    return reranked;
  }

  private static temporalDecay(
    results: { chunk: MemoryChunk; score: number }[],
    decayRate: number = 0.01
  ): { chunk: MemoryChunk; score: number }[] {
    const now = new Date();
    for (const r of results) {
      const path = r.chunk.path;
      const dateMatch = path.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        try {
          const chunkDate = new Date(dateMatch[1]);
          const ageDays =
            (now.getTime() - chunkDate.getTime()) / (1000 * 60 * 60 * 24);
          r.score *= Math.exp(-decayRate * ageDays);
        } catch {
          // 忽略日期解析错误
        }
      }
    }
    return results;
  }

  async hybridSearch(query: string, topK: number = 5): Promise<SearchResult[]> {
    const chunks = await this.loadAllChunks();
    if (chunks.length === 0) return [];
    const keywordResults = await this.keywordSearch(query, 10);
    const vectorResults = await this.vectorSearch(query, 10);
    let merged = MemoryStore.mergeHybrid(vectorResults, keywordResults);
    merged = MemoryStore.temporalDecay(merged);
    merged = MemoryStore.mmrRerank(merged);
    return merged.slice(0, topK).map((r) => ({
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
    const evergreen = await this.loadEvergreen();
    let dailyFiles = 0;
    let dailyEntries = 0;
    try {
      const files = await fs.readdir(this.memoryDir);
      dailyFiles = files.filter((f) => f.endsWith(".jsonl")).length;
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const content = await fs.readFile(
          path.join(this.memoryDir, file),
          "utf-8"
        );
        dailyEntries += content.split("\n").filter((l) => l.trim()).length;
      }
    } catch {
      // 忽略错误
    }
    return { evergreenChars: evergreen.length, dailyFiles, dailyEntries };
  }
}

// ---------------------------------------------------------------------------
// 记忆工具
// ---------------------------------------------------------------------------
const memoryStore = new MemoryStore(WORKSPACE_DIR);

async function toolMemoryWrite(
  content: string,
  category: string = "general"
): Promise<string> {
  printTool("memory_write", `[${category}] ${content.slice(0, 60)}...`);
  return await memoryStore.writeMemory(content, category);
}

async function toolMemorySearch(
  query: string,
  topK: number = 5
): Promise<string> {
  printTool("memory_search", query);
  const results = await memoryStore.hybridSearch(query, topK);
  if (results.length === 0) return "No relevant memories found.";
  return results
    .map((r) => `[${r.path}] (score: ${r.score}) ${r.snippet}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// 工具定义 (Zod Schema)
// ---------------------------------------------------------------------------
const MemoryWriteInput = z.object({
  content: z.string().describe("The fact or observation to remember."),
  category: z
    .string()
    .optional()
    .describe("Category: preference, fact, context, etc."),
});
const MemorySearchInput = z.object({
  query: z.string().describe("Search query."),
  top_k: z.number().optional().describe("Max results. Default: 5."),
});

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Save an important fact or observation to long-term memory.",
      parameters: MemoryWriteInput.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search stored memories for relevant information, ranked by similarity.",
      parameters: MemorySearchInput.toJSONSchema() as any,
    },
  },
];

type ToolHandler = (args: any) => Promise<string>;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
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

// ---------------------------------------------------------------------------
// 5. 系统提示词组装
// ---------------------------------------------------------------------------
function buildSystemPrompt(
  mode: string = "full",
  bootstrap: Record<string, string> = {},
  skillsBlock: string = "",
  memoryContext: string = "",
  agentId: string = "main",
  channel: string = "terminal"
): string {
  const sections: string[] = [];

  // 第1层: 身份
  const identity =
    bootstrap["IDENTITY.md"]?.trim() ||
    "You are a helpful personal AI assistant.";
  sections.push(identity);

  // 第2层: 灵魂
  if (mode === "full") {
    const soul = bootstrap["SOUL.md"]?.trim();
    if (soul) sections.push(`## Personality\n\n${soul}`);
  }

  // 第3层: 工具指南
  const toolsMd = bootstrap["TOOLS.md"]?.trim();
  if (toolsMd) sections.push(`## Tool Usage Guidelines\n\n${toolsMd}`);

  // 第4层: 技能
  if (mode === "full" && skillsBlock) sections.push(skillsBlock);

  // 第5层: 记忆
  if (mode === "full") {
    const memParts: string[] = [];
    const memMd = bootstrap["MEMORY.md"]?.trim();
    if (memMd) memParts.push(`### Evergreen Memory\n\n${memMd}`);
    if (memoryContext)
      memParts.push(
        `### Recalled Memories (auto-searched)\n\n${memoryContext}`
      );
    if (memParts.length) sections.push("## Memory\n\n" + memParts.join("\n\n"));
    sections.push(
      "## Memory Instructions\n\n" +
        "- Use memory_write to save important user facts and preferences.\n" +
        "- Reference remembered facts naturally in conversation.\n" +
        "- Use memory_search to recall specific past information."
    );
  }

  // 第6层: Bootstrap 上下文
  if (mode === "full" || mode === "minimal") {
    for (const name of [
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
      "AGENTS.md",
      "USER.md",
    ]) {
      const content = bootstrap[name]?.trim();
      if (content) sections.push(`## ${name.replace(".md", "")}\n\n${content}`);
    }
  }

  // 第7层: 运行时上下文
  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  sections.push(
    `## Runtime Context\n\n` +
      `- Agent ID: ${agentId}\n- Model: ${MODEL_ID}\n` +
      `- Channel: ${channel}\n- Current time: ${now}\n- Prompt mode: ${mode}`
  );

  // 第8层: 渠道提示
  const hints: Record<string, string> = {
    terminal: "You are responding via a terminal REPL. Markdown is supported.",
    telegram: "You are responding via Telegram. Keep messages concise.",
    discord:
      "You are responding via Discord. Keep messages under 2000 characters.",
    slack: "You are responding via Slack. Use Slack mrkdwn formatting.",
  };
  sections.push(
    `## Channel\n\n${hints[channel] || `You are responding via ${channel}.`}`
  );

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// REPL 命令处理
// ---------------------------------------------------------------------------
async function handleReplCommand(
  cmd: string,
  bootstrapData: Record<string, string>,
  skillsMgr: SkillsManager,
  skillsBlock: string
): Promise<boolean> {
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ");

  if (command === "/soul") {
    printSection("SOUL.md");
    const soul = bootstrapData["SOUL.md"] || "";
    console.log(soul || `${DIM}(未找到 SOUL.md)${RESET}`);
    return true;
  }

  if (command === "/skills") {
    printSection("已发现的技能");
    if (skillsMgr.skills.length === 0) {
      console.log(`${DIM}(未找到技能)${RESET}`);
    } else {
      for (const s of skillsMgr.skills) {
        console.log(
          `  ${BLUE}${s.invocation}${RESET}  ${s.name} - ${s.description}`
        );
        console.log(`    ${DIM}path: ${s.path}${RESET}`);
      }
    }
    return true;
  }

  if (command === "/memory") {
    printSection("记忆统计");
    const stats = await memoryStore.getStats();
    console.log(`  长期记忆 (MEMORY.md): ${stats.evergreenChars} 字符`);
    console.log(`  每日文件: ${stats.dailyFiles}`);
    console.log(`  每日条目: ${stats.dailyEntries}`);
    return true;
  }

  if (command === "/search") {
    if (!arg) {
      console.log(`${YELLOW}用法: /search <query>${RESET}`);
      return true;
    }
    printSection(`记忆搜索: ${arg}`);
    const results = await memoryStore.hybridSearch(arg);
    if (results.length === 0) {
      console.log(`${DIM}(无结果)${RESET}`);
    } else {
      for (const r of results) {
        const color = r.score > 0.3 ? GREEN : DIM;
        console.log(`  ${color}[${r.score}]${RESET} ${r.path}`);
        console.log(`    ${r.snippet}`);
      }
    }
    return true;
  }

  if (command === "/prompt") {
    printSection("完整系统提示词");
    const memoryContext = await autoRecall("show prompt");
    const prompt = buildSystemPrompt(
      "full",
      bootstrapData,
      skillsBlock,
      memoryContext
    );
    if (prompt.length > 3000) {
      console.log(prompt.slice(0, 3000));
      console.log(
        `\n${DIM}... (${prompt.length - 3000} more chars, total ${
          prompt.length
        })${RESET}`
      );
    } else {
      console.log(prompt);
    }
    console.log(`\n${DIM}提示词总长度: ${prompt.length} 字符${RESET}`);
    return true;
  }

  if (command === "/bootstrap") {
    printSection("Bootstrap 文件");
    if (Object.keys(bootstrapData).length === 0) {
      console.log(`${DIM}(未加载 Bootstrap 文件)${RESET}`);
    } else {
      for (const [name, content] of Object.entries(bootstrapData)) {
        console.log(`  ${BLUE}${name}${RESET}: ${content.length} chars`);
      }
    }
    const total = Object.values(bootstrapData).reduce(
      (sum, c) => sum + c.length,
      0
    );
    console.log(
      `\n  ${DIM}总计: ${total} 字符 (上限: ${MAX_TOTAL_CHARS})${RESET}`
    );
    return true;
  }

  return false;
}

async function autoRecall(userMessage: string): Promise<string> {
  const results = await memoryStore.hybridSearch(userMessage, 3);
  if (results.length === 0) return "";
  return results.map((r) => `- [${r.path}] ${r.snippet}`).join("\n");
}

// ---------------------------------------------------------------------------
// Agent 循环
// ---------------------------------------------------------------------------
async function agentLoop() {
  const loader = new BootstrapLoader(WORKSPACE_DIR);
  const bootstrapData = await loader.loadAll("full");

  const skillsMgr = new SkillsManager(WORKSPACE_DIR);
  await skillsMgr.discover();
  const skillsBlock = skillsMgr.formatPromptBlock();

  const messages: ChatCompletionMessageParam[] = [];

  printInfo("=".repeat(60));
  printInfo("  claw0  |  Section 06: Intelligence");
  printInfo(`  Model: ${MODEL_ID}`);
  printInfo(`  Workspace: ${WORKSPACE_DIR}`);
  printInfo(`  Bootstrap 文件: ${Object.keys(bootstrapData).length}`);
  printInfo(`  已发现技能: ${skillsMgr.skills.length}`);
  const stats = await memoryStore.getStats();
  printInfo(
    `  记忆: 长期 ${stats.evergreenChars}字符, ${stats.dailyFiles} 个每日文件`
  );
  printInfo("  命令: /soul /skills /memory /search /prompt /bootstrap");
  printInfo("  输入 'quit' 或 'exit' 退出.");
  printInfo("=".repeat(60));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (query: string): Promise<string> => {
    return new Promise((resolve) => rl.question(query, resolve));
  };

  while (true) {
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

    if (userInput.startsWith("/")) {
      if (
        await handleReplCommand(
          userInput,
          bootstrapData,
          skillsMgr,
          skillsBlock
        )
      ) {
        continue;
      }
    }

    const memoryContext = await autoRecall(userInput);
    if (memoryContext) printInfo("  [自动召回] 找到相关记忆");

    const systemPrompt = buildSystemPrompt(
      "full",
      bootstrapData,
      skillsBlock,
      memoryContext
    );

    messages.push({ role: "user", content: userInput });

    // 内循环处理工具调用
    while (true) {
      try {
        const response = await openai.chat.completions.create({
          model: MODEL_ID,
          max_tokens: 8096,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          tools: TOOLS,
          tool_choice: "auto",
        });

        const choice = response.choices[0];
        messages.push(choice.message);

        if (choice.finish_reason === "stop") {
          const text = choice.message.content || "";
          if (text) printAssistant(text);
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
          const text =
            choice.message.content || `[stop=${choice.finish_reason}]`;
          printAssistant(text);
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
        break;
      }
    }
  }

  rl.close();
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  if (!OPENAI_API_KEY) {
    console.error(`${YELLOW}错误: 未设置 OPENAI_API_KEY.${RESET}`);
    process.exit(1);
  }
  if (!existsSync(WORKSPACE_DIR)) {
    console.error(`${YELLOW}错误: 未找到工作区目录: ${WORKSPACE_DIR}${RESET}`);
    process.exit(1);
  }
  await agentLoop();
}

main().catch((err) => {
  console.error(`${YELLOW}Unhandled error: ${err}${RESET}`);
  process.exit(1);
});
