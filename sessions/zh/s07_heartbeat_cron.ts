/**
 * Section 07: Heartbeat & Cron (TypeScript 版本)
 * "Not just reactive -- proactive"
 *
 * 定时线程检查"是否应该运行?", 然后将工作放入与用户消息相同的管道中.
 * Lane 互斥机制给予用户消息优先权.
 *
 * 用法:
 *   npx ts-node s07_heartbeat_cron.ts
 *
 * 依赖: OPENAI_API_KEY, MODEL_ID (在 .env 中配置)
 * 工作区文件: HEARTBEAT.md, SOUL.md, MEMORY.md, CRON.json
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { existsSync } from "node:fs";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { Mutex } from "async-mutex";
import cronParser from "cron-parser";

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
const CRON_DIR = path.join(WORKSPACE_DIR, "cron");

// 确保目录存在
fs.mkdir(WORKSPACE_DIR, { recursive: true }).catch(() => {});
fs.mkdir(CRON_DIR, { recursive: true }).catch(() => {});

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
const ORANGE = "\x1b[38;5;208m";

function coloredPrompt(): string {
  return `${CYAN}${BOLD}You > ${RESET}`;
}

function printAssistant(text: string): void {
  console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${text}\n`);
}

function printInfo(text: string): void {
  console.log(`${DIM}${text}${RESET}`);
}

function printHeartbeat(text: string): void {
  console.log(`${BLUE}${BOLD}[heartbeat]${RESET} ${text}`);
}

function printCron(text: string): void {
  console.log(`${MAGENTA}${BOLD}[cron]${RESET} ${text}`);
}

// ---------------------------------------------------------------------------
// Soul + Memory (简化版)
// ---------------------------------------------------------------------------
class SoulSystem {
  constructor(private workspace: string) {}

  load(): string {
    const soulPath = path.join(this.workspace, "SOUL.md");
    if (existsSync(soulPath)) {
      return fsSync.readFileSync(soulPath, "utf-8").trim();
    }
    return "You are a helpful AI assistant.";
  }

  buildSystemPrompt(extra: string = ""): string {
    const parts = [this.load()];
    if (extra) parts.push(extra);
    return parts.join("\n\n");
  }
}

class MemoryStore {
  constructor(private workspace: string) {}

  loadEvergreen(): string {
    const memoryPath = path.join(this.workspace, "MEMORY.md");
    if (existsSync(memoryPath)) {
      return fsSync.readFileSync(memoryPath, "utf-8").trim();
    }
    return "";
  }

  writeMemory(content: string): string {
    const memoryPath = path.join(this.workspace, "MEMORY.md");
    const existing = this.loadEvergreen();
    const updated = existing
      ? existing + "\n\n" + content.trim()
      : content.trim();
    fsSync.writeFileSync(memoryPath, updated, "utf-8");
    return `Memory saved (${content.length} chars)`;
  }

  searchMemory(query: string): string {
    const text = this.loadEvergreen();
    if (!text) return "No memories found.";
    const matches = text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(query.toLowerCase()));
    return matches.length
      ? matches.slice(0, 10).join("\n")
      : `No memories matching '${query}'.`;
  }
}

// ---------------------------------------------------------------------------
// 记忆工具定义 (Zod)
// ---------------------------------------------------------------------------
const MemoryWriteInput = z.object({
  content: z.string().describe("The fact or preference to remember."),
});
const MemorySearchInput = z.object({
  query: z.string().describe("Search query."),
});

const MEMORY_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Save an important fact or preference to long-term memory.",
      parameters: MemoryWriteInput.toJSONSchema() as any,
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Search long-term memory for relevant information.",
      parameters: MemorySearchInput.toJSONSchema() as any,
    },
  },
];

// ---------------------------------------------------------------------------
// Agent 辅助函数 -- 单轮 LLM 调用 (heartbeat 和 cron 共用)
// ---------------------------------------------------------------------------
async function runAgentSingleTurn(
  prompt: string,
  systemPrompt?: string
): Promise<string> {
  const sysPrompt =
    systemPrompt ||
    "You are a helpful assistant performing a background check.";
  try {
    const response = await openai.chat.completions.create({
      model: MODEL_ID,
      max_tokens: 2048,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: prompt },
      ],
    });
    return response.choices[0]?.message?.content?.trim() || "";
  } catch (err: any) {
    return `[agent error: ${err.message}]`;
  }
}

// ---------------------------------------------------------------------------
// HeartbeatRunner
// ---------------------------------------------------------------------------
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
  private lastRunAt: number = 0;
  private running: boolean = false;
  private stopped: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private outputQueue: string[] = [];
  private lastOutput: string = "";
  private soul: SoulSystem;
  private memory: MemoryStore;

  constructor(
    workspace: string,
    laneMutex: Mutex,
    interval: number = 1800,
    activeHours: [number, number] = [9, 22],
    maxQueueSize: number = 10
  ) {
    this.heartbeatPath = path.join(workspace, "HEARTBEAT.md");
    this.laneMutex = laneMutex;
    this.interval = interval;
    this.activeHours = activeHours;
    this.maxQueueSize = maxQueueSize;
    this.soul = new SoulSystem(workspace);
    this.memory = new MemoryStore(workspace);
  }

  private shouldRun(): [boolean, string] {
    if (!existsSync(this.heartbeatPath)) {
      return [false, "HEARTBEAT.md not found"];
    }
    try {
      const content = fsSync.readFileSync(this.heartbeatPath, "utf-8").trim();
      if (!content) return [false, "HEARTBEAT.md is empty"];
    } catch {
      return [false, "cannot read HEARTBEAT.md"];
    }
    const now = Date.now() / 1000;
    const elapsed = now - this.lastRunAt;
    if (elapsed < this.interval) {
      return [
        false,
        `interval not elapsed (${Math.round(
          this.interval - elapsed
        )}s remaining)`,
      ];
    }
    const hour = new Date().getHours();
    const [start, end] = this.activeHours;
    const inHours =
      start <= end ? hour >= start && hour < end : hour >= start || hour < end;
    if (!inHours) {
      return [false, `outside active hours (${start}:00-${end}:00)`];
    }
    if (this.running) {
      return [false, "already running"];
    }
    return [true, "all checks passed"];
  }

  private parseResponse(response: string): string | null {
    if (response.includes("HEARTBEAT_OK")) {
      const stripped = response.replace("HEARTBEAT_OK", "").trim();
      return stripped.length > 5 ? stripped : null;
    }
    return response.trim() || null;
  }

  private buildHeartbeatPrompt(): [string, string] {
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
    // 非阻塞获取锁
    if (this.laneMutex.isLocked()) return;
    const release = await this.laneMutex.acquire();
    this.running = true;
    try {
      const [instructions, sysPrompt] = this.buildHeartbeatPrompt();
      if (!instructions) return;
      const response = await runAgentSingleTurn(instructions, sysPrompt);
      const meaningful = this.parseResponse(response);
      if (meaningful === null) return;
      if (meaningful === this.lastOutput) return;
      this.lastOutput = meaningful;
      this.outputQueue.push(meaningful);
      if (this.outputQueue.length > this.maxQueueSize) {
        this.outputQueue.shift();
      }
    } catch (err: any) {
      this.outputQueue.push(`[heartbeat error: ${err.message}]`);
    } finally {
      this.running = false;
      this.lastRunAt = Date.now() / 1000;
      release();
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const [ok] = this.shouldRun();
        if (ok) {
          await this.execute();
        }
      } catch {
        // 忽略错误
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // 使用递归 setTimeout 而非 setInterval 避免重叠
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
    if (this.laneMutex.isLocked()) {
      return "main lane occupied, cannot trigger";
    }
    const release = await this.laneMutex.acquire();
    this.running = true;
    try {
      const [instructions, sysPrompt] = this.buildHeartbeatPrompt();
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
      this.running = false;
      this.lastRunAt = Date.now() / 1000;
      release();
    }
  }

  status(): HeartbeatStatus {
    const now = Date.now() / 1000;
    const elapsed = this.lastRunAt > 0 ? now - this.lastRunAt : null;
    const nextIn =
      elapsed !== null ? Math.max(0, this.interval - elapsed) : this.interval;
    const [ok, reason] = this.shouldRun();
    return {
      enabled: existsSync(this.heartbeatPath),
      running: this.running,
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

// ---------------------------------------------------------------------------
// CronJob + CronService
// ---------------------------------------------------------------------------
const CRON_AUTO_DISABLE_THRESHOLD = 5;

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
  consecutiveErrors: number = 0;
  lastRunAt: number = 0;
  nextRunAt: number = 0;

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

  constructor(workspace: string) {
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
        const kind = jd.schedule?.kind;
        if (!["at", "every", "cron"].includes(kind)) continue;
        const job = new CronJob(jd);
        job.nextRunAt = this.computeNext(job, now);
        this.jobs.push(job);
      }
    } catch (err: any) {
      console.log(`${YELLOW}CRON.json load error: ${err.message}${RESET}`);
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
      const steps = Math.floor((now - anchor) / every) + 1;
      return anchor + steps * every;
    }
    if (job.scheduleKind === "cron") {
      const expr = cfg.expr;
      if (!expr) return 0;
      try {
        const interval = cronParser.parse(expr, {
          currentDate: new Date(now * 1000),
        });
        return interval.next().getTime() / 1000;
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
      if (job.deleteAfterRun && job.scheduleKind === "at") {
        removeIds.push(job.id);
      }
    }
    if (removeIds.length) {
      this.jobs = this.jobs.filter((j) => !removeIds.includes(j.id));
    }
  }

  private async runJob(job: CronJob, now: number): Promise<void> {
    const payload = job.payload;
    const kind = payload.kind;
    let output = "";
    let status = "ok";
    let error = "";
    try {
      if (kind === "agent_turn") {
        const msg = payload.message;
        if (!msg) {
          output = "[empty message]";
          status = "skipped";
        } else {
          const sysPrompt = `You are performing a scheduled background task. Be concise. Current time: ${new Date()
            .toISOString()
            .slice(0, 19)
            .replace("T", " ")}`;
          output = await runAgentSingleTurn(msg, sysPrompt);
        }
      } else if (kind === "system_event") {
        output = payload.text || "";
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
        const msg = `Job '${job.name}' auto-disabled after ${job.consecutiveErrors} consecutive errors: ${error}`;
        console.log(`${RED}${msg}${RESET}`);
        this.outputQueue.push(msg);
      }
    } else {
      job.consecutiveErrors = 0;
    }
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

    if (output && status !== "skipped") {
      this.outputQueue.push(`[${job.name}] ${output}`);
    }
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

// ---------------------------------------------------------------------------
// REPL + Agent 循环
// ---------------------------------------------------------------------------
function printReplHelp(): void {
  printInfo("REPL commands:");
  printInfo("  /heartbeat         -- heartbeat status");
  printInfo("  /trigger           -- force heartbeat now");
  printInfo("  /cron              -- list cron jobs");
  printInfo("  /cron-trigger <id> -- trigger a cron job");
  printInfo("  /lanes             -- lane lock status");
  printInfo("  /help              -- this help");
  printInfo("  quit / exit        -- exit");
}

async function agentLoop() {
  const laneMutex = new Mutex();
  const soul = new SoulSystem(WORKSPACE_DIR);
  const memory = new MemoryStore(WORKSPACE_DIR);

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
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  cronLoop(); // 启动异步循环

  const messages: ChatCompletionMessageParam[] = [];
  const memText = memory.loadEvergreen();
  const extra = memText ? `## Long-term Memory\n\n${memText}` : "";
  const systemPrompt = soul.buildSystemPrompt(extra);

  const handleTool = (name: string, input: any): string => {
    if (name === "memory_write") return memory.writeMemory(input.content || "");
    if (name === "memory_search") return memory.searchMemory(input.query || "");
    return `Unknown tool: ${name}`;
  };

  const hbStatus = heartbeat.status();
  printInfo("=".repeat(60));
  printInfo("  claw0  |  Section 07: Heartbeat & Cron");
  printInfo(`  Model: ${MODEL_ID}`);
  printInfo(
    `  Heartbeat: ${hbStatus.enabled ? "on" : "off"} (${
      heartbeat["interval"]
    }s)`
  );
  printInfo(`  Cron jobs: ${cronSvc.jobs.length}`);
  printInfo("  /help for commands. quit to exit.");
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
    // 输出后台消息
    for (const msg of heartbeat.drainOutput()) printHeartbeat(msg);
    for (const msg of cronSvc.drainOutput()) printCron(msg);

    let userInput = "";
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
      const parts = userInput.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(" ");

      if (cmd === "/help") {
        printReplHelp();
      } else if (cmd === "/heartbeat") {
        const status = heartbeat.status();
        for (const [k, v] of Object.entries(status)) {
          printInfo(`  ${k}: ${v}`);
        }
      } else if (cmd === "/trigger") {
        printInfo(`  ${await heartbeat.trigger()}`);
        for (const m of heartbeat.drainOutput()) printHeartbeat(m);
      } else if (cmd === "/cron") {
        const jobs = cronSvc.listJobs();
        if (!jobs.length) printInfo("No cron jobs.");
        else {
          for (const j of jobs) {
            const tag = j.enabled ? `${GREEN}ON${RESET}` : `${RED}OFF${RESET}`;
            const err = j.errors ? ` ${YELLOW}err:${j.errors}${RESET}` : "";
            const nxt = j.nextIn !== null ? ` in ${j.nextIn}s` : "";
            console.log(`  [${tag}] ${j.id} - ${j.name}${err}${nxt}`);
          }
        }
      } else if (cmd === "/cron-trigger") {
        if (!arg) {
          console.log(`${YELLOW}Usage: /cron-trigger <job_id>${RESET}`);
        } else {
          printInfo(`  ${cronSvc.triggerJob(arg)}`);
          for (const m of cronSvc.drainOutput()) printCron(m);
        }
      } else if (cmd === "/lanes") {
        const locked = laneMutex.isLocked();
        printInfo(
          `  main_locked: ${locked}  heartbeat_running: ${heartbeat["running"]}`
        );
      } else {
        console.log(`${YELLOW}Unknown: ${cmd}. /help for commands.${RESET}`);
      }
      continue;
    }

    // 用户对话，阻塞获取锁
    const release = await laneMutex.acquire();
    try {
      messages.push({ role: "user", content: userInput });
      while (true) {
        try {
          const response = await openai.chat.completions.create({
            model: MODEL_ID,
            max_tokens: 8096,
            messages: [{ role: "system", content: systemPrompt }, ...messages],
            tools: MEMORY_TOOLS,
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
              printInfo(`  [tool: ${tc.function.name}]`);
              const args = JSON.parse(tc.function.arguments);
              const result = handleTool(tc.function.name, args);
              toolMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result,
              });
            }
            messages.push(...toolMessages);
          } else {
            printInfo(`[finish_reason=${choice.finish_reason}]`);
            const text = choice.message.content || "";
            if (text) printAssistant(text);
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
    } finally {
      release();
    }
  }

  heartbeat.stop();
  cronStopped = true;
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
