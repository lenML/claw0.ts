/**
 * Section 01: Agent 循环
 * "Agent 就是 while True + stop_reason"
 *
 * 用法:
 *   npx tsx s01_agent_loop.ts
 *
 * 需要在 .env 中配置:
 *   OPENAI_API_KEY=sk-xxxxx
 *   OPENAI_BASE_URL=https://api.openai.com/v1  (可选)
 *   MODEL_ID=gpt-4o  (或其他支持 function calling 的模型)
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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

const SYSTEM_PROMPT =
  "You are a helpful AI assistant. Answer questions directly.";

// ---------------------------------------------------------------------------
// ANSI 颜色
// ---------------------------------------------------------------------------
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function coloredPrompt(): string {
  return `${CYAN}${BOLD}You > ${RESET}`;
}

function printAssistant(text: string): void {
  console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${text}\n`);
}

function printInfo(text: string): void {
  console.log(`${DIM}${text}${RESET}`);
}

// ---------------------------------------------------------------------------
// 核心: Agent 循环
// ---------------------------------------------------------------------------
//   1. 收集用户输入, 追加到 messages
//   2. 调用 API
//   3. 检查 finish_reason 决定下一步
//
//   本节 finish_reason 通常是 "stop" (没有工具调用).
//   下一节加入 "tool_calls" -- 循环结构保持不变.
// ---------------------------------------------------------------------------

async function agentLoop(): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [];

  printInfo("=".repeat(60));
  printInfo("  claw0  |  Section 01: Agent 循环");
  printInfo(`  Model: ${MODEL_ID}`);
  printInfo("  输入 'quit' 或 'exit' 退出. Ctrl+C 同样有效.");
  printInfo("=".repeat(60));
  console.log();

  // 创建 readline 接口
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
    // --- 获取用户输入 ---
    let userInput: string;
    try {
      userInput = (await askQuestion(coloredPrompt())).trim();
    } catch (err) {
      // 处理 Ctrl+C 等中断
      console.log(`\n${DIM}再见.${RESET}`);
      break;
    }

    if (!userInput) {
      continue;
    }

    if (
      userInput.toLowerCase() === "quit" ||
      userInput.toLowerCase() === "exit"
    ) {
      console.log(`${DIM}再见.${RESET}`);
      break;
    }

    // --- 追加到历史 ---
    messages.push({
      role: "user",
      content: userInput,
    });

    // --- 调用 LLM (OpenAI) ---
    try {
      const response = await openai.chat.completions.create({
        model: MODEL_ID,
        max_tokens: 8096,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      });

      const choice = response.choices[0];
      const finishReason = choice.finish_reason;

      // --- 检查 finish_reason ---
      if (finishReason === "stop") {
        const assistantText = choice.message.content || "";
        printAssistant(assistantText);

        messages.push({
          role: "assistant",
          content: assistantText,
        });
      } else if (
        finishReason === "tool_calls" ||
        finishReason === "function_call"
      ) {
        // 注意：OpenAI 的 function_call 是旧版，新版是 tool_calls
        printInfo("[finish_reason=tool_calls] 本节没有可用工具.");
        printInfo("参见 s02_tool_use.ts 了解工具支持.");

        // 将 assistant 消息（包含 tool_calls）原样保存
        messages.push(choice.message);
      } else {
        printInfo(`[finish_reason=${finishReason}]`);
        const assistantText = choice.message.content || "";
        if (assistantText) {
          printAssistant(assistantText);
        }
        messages.push(choice.message);
      }
    } catch (error: any) {
      console.error(`\n${YELLOW}API Error: ${error.message}${RESET}\n`);
      // 回滚未成功的用户消息
      messages.pop();
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
