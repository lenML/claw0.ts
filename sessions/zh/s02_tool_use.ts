/**
 * Section 02: Tool Use (TypeScript 版本)
 * "Give the model hands"
 *
 * Agent 循环本身没变 -- 我们只是加了一张调度表.
 * 当 finish_reason == "tool_calls" 时, 从 TOOL_HANDLERS 查到函数, 执行,
 * 把结果塞回去, 然后继续循环. 就这么简单.
 *
 * 工具清单:
 *    - bash        : 执行 shell 命令
 *    - read_file   : 读取文件内容
 *    - write_file  : 写入文件
 *    - edit_file   : 精确替换文件中的文本
 *
 * 运行方式:
 *    npx ts-node s02_tool_use.ts
 *
 * 需要在 .env 中配置:
 *    OPENAI_API_KEY=sk-xxxxx
 *    OPENAI_BASE_URL=https://api.openai.com/v1   (可选)
 *    MODEL_ID=gpt-4o
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";

const execPromise = promisify(exec);

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
  "Use the tools to help the user with file operations and shell commands.",
  "Always read a file before editing it.",
  "When using edit_file, the old_string must match EXACTLY (including whitespace).",
].join("\n");

// 工具输出最大字符数 -- 防止超大输出撑爆上下文
const MAX_TOOL_OUTPUT = 50000;

// 工作目录 -- 所有文件操作相对于此目录, 防止路径穿越
const WORKDIR = process.cwd();

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

// ---------------------------------------------------------------------------
// 安全辅助函数
// ---------------------------------------------------------------------------
function safePath(raw: string): string {
  const resolved = path.resolve(WORKDIR, raw);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path traversal blocked: ${raw} resolves outside WORKDIR`);
  }
  return resolved;
}

function truncate(text: string, limit: number = MAX_TOOL_OUTPUT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... [truncated, ${text.length} total chars]`;
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------
async function toolBash(
  command: string,
  timeout: number = 30
): Promise<string> {
  // 基础安全检查
  const dangerous = ["rm -rf /", "mkfs", "> /dev/sd", "dd if="];
  for (const pattern of dangerous) {
    if (command.includes(pattern)) {
      return `Error: Refused to run dangerous command containing '${pattern}'`;
    }
  }

  printTool("bash", command);
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: WORKDIR,
      timeout: timeout * 1000,
    });

    let output = "";
    if (stdout) output += stdout;
    if (stderr) output += (output ? "\n--- stderr ---\n" : "") + stderr;
    return truncate(output) || "[no output]";
  } catch (error: any) {
    if (error.killed && error.signal === "SIGTERM") {
      return `Error: Command timed out after ${timeout}s`;
    }
    // exec 抛出错误时仍可能有 stdout/stderr
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
    const target = safePath(filePath);
    const content = await fs.readFile(target, "utf-8");
    return truncate(content);
  } catch (error: any) {
    if (error.code === "ENOENT") return `Error: File not found: ${filePath}`;
    return `Error: ${error.message}`;
  }
}

async function toolWriteFile(
  filePath: string,
  content: string
): Promise<string> {
  printTool("write_file", filePath);
  try {
    const target = safePath(filePath);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, content, "utf-8");
    return `Successfully wrote ${content.length} chars to ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
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

    if (count === 0) {
      return "Error: old_string not found in file. Make sure it matches exactly.";
    }
    if (count > 1) {
      return `Error: old_string found ${count} times. It must be unique. Provide more surrounding context.`;
    }

    const newContent = content.replace(oldString, newString);
    await fs.writeFile(target, newContent, "utf-8");
    return `Successfully edited ${filePath}`;
  } catch (error: any) {
    if (error.code === "ENOENT") return `Error: File not found: ${filePath}`;
    return `Error: ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// 工具定义: Schema (Zod) + Handler 调度表
// ---------------------------------------------------------------------------
// 使用 zod 定义每个工具的输入 schema，然后通过 z.toJSONSchema 生成 OpenAI 格式
const BashInputSchema = z.object({
  command: z.string().describe("The shell command to execute."),
  timeout: z.number().optional().describe("Timeout in seconds. Default 30."),
});

const ReadFileInputSchema = z.object({
  file_path: z
    .string()
    .describe("Path to the file (relative to working directory)."),
});

const WriteFileInputSchema = z.object({
  file_path: z
    .string()
    .describe("Path to the file (relative to working directory)."),
  content: z.string().describe("The content to write."),
});

const EditFileInputSchema = z.object({
  file_path: z
    .string()
    .describe("Path to the file (relative to working directory)."),
  old_string: z
    .string()
    .describe("The exact text to find and replace. Must be unique."),
  new_string: z.string().describe("The replacement text."),
});

// 转换为 OpenAI 要求的 tools 数组格式
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command and return its output. Use for system commands, git, package managers, etc.",
      parameters: z.toJSONSchema(BashInputSchema),
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file.",
      parameters: z.toJSONSchema(ReadFileInputSchema),
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file. Creates parent directories if needed. Overwrites existing content.",
      parameters: z.toJSONSchema(WriteFileInputSchema),
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact string in a file with a new string. The old_string must appear exactly once in the file. Always read the file first to get the exact text to replace.",
      parameters: z.toJSONSchema(EditFileInputSchema),
    },
  },
];

// 调度表: 工具名 -> 处理函数
type ToolHandler = (args: any) => Promise<string> | string;
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => toolBash(args.command, args.timeout),
  read_file: (args) => toolReadFile(args.file_path),
  write_file: (args) => toolWriteFile(args.file_path, args.content),
  edit_file: (args) =>
    toolEditFile(args.file_path, args.old_string, args.new_string),
};

// ---------------------------------------------------------------------------
// 工具调用处理
// ---------------------------------------------------------------------------
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
  } catch (error: any) {
    return `Error: ${toolName} failed: ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// 核心: Agent 循环
// ---------------------------------------------------------------------------
async function agentLoop(): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [];

  printInfo("=".repeat(60));
  printInfo("  claw0  |  Section 02: 工具使用 (TypeScript)");
  printInfo(`  Model: ${MODEL_ID}`);
  printInfo(`  Workdir: ${WORKDIR}`);
  printInfo(`  Tools: ${Object.keys(TOOL_HANDLERS).join(", ")}`);
  printInfo("  输入 'quit' 或 'exit' 退出, Ctrl+C 同样有效.");
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
    // --- Step 1: 获取用户输入 ---
    let userInput: string;
    try {
      userInput = (await askQuestion(coloredPrompt())).trim();
    } catch (err) {
      console.log(`\n${DIM}再见.${RESET}`);
      break;
    }

    if (!userInput) continue;

    if (
      userInput.toLowerCase() === "quit" ||
      userInput.toLowerCase() === "exit"
    ) {
      console.log(`${DIM}再见.${RESET}`);
      break;
    }

    // --- Step 2: 追加 user 消息 ---
    messages.push({
      role: "user",
      content: userInput,
    });

    // --- Step 3: Agent 内循环 ---
    while (true) {
      try {
        const response = await openai.chat.completions.create({
          model: MODEL_ID,
          max_tokens: 8096,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
          tools: TOOLS,
          tool_choice: "auto",
          temperature: 1,
          top_p: 0.95,
          frequency_penalty: 0,
          presence_penalty: 0,
        });

        const choice = response.choices[0];
        const finishReason = choice.finish_reason;

        // 追加 assistant 消息到历史 (可能包含 tool_calls 或普通文本)
        messages.push(choice.message);

        // --- 检查 finish_reason ---
        if (finishReason === "stop") {
          // 模型自然结束
          const assistantText = choice.message.content || "";
          if (assistantText) {
            printAssistant(assistantText);
          }
          break; // 跳出内循环，等待下一次用户输入
        } else if (finishReason === "tool_calls") {
          // 模型想调用工具
          const toolCalls = choice.message.tool_calls;
          if (!toolCalls || toolCalls.length === 0) {
            printInfo("[tool_calls finish but no tool_calls?]");
            break;
          }

          // 并行执行所有工具调用 (保持顺序追加结果)
          const toolResults: ChatCompletionMessageParam[] = [];
          for (const tc of toolCalls) {
            if (tc.type !== "function") continue;

            const funcName = tc.function.name;
            let args: any = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              // 忽略解析错误，后面处理函数会报错
            }

            const result = await processToolCall(funcName, args);

            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
          }

          // 将所有工具结果追加到历史
          messages.push(...toolResults);
          // 继续内循环，模型会看到工具结果并决定下一步
          continue;
        } else {
          // 其他情况 (length, content_filter 等)
          printInfo(`[finish_reason=${finishReason}]`);
          const assistantText = choice.message.content || "";
          if (assistantText) {
            printAssistant(assistantText);
          }
          break;
        }
      } catch (error: any) {
        console.error(`\n${YELLOW}API Error: ${error.message}${RESET}\n`);
        // 回滚本轮消息到最近的 user 消息
        while (
          messages.length > 0 &&
          messages[messages.length - 1].role !== "user"
        ) {
          messages.pop();
        }
        if (messages.length > 0) {
          messages.pop(); // 移除导致错误的 user 消息
        }
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
