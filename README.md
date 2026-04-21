# claw0.ts

0 - 1 学习 OpenClaw：从零开始构建 Claw AI 智能体的章节 （Typescript 版本）

> NOTE: 精简了一些工程实现，只做了 01-07 章节。并且只实现中文版本。

[开始 s01_agent_loop.md](./sessions/zh/s01_agent_loop.md)

**从零到一: 构建 AI Agent 网关**

> 7 个渐进式章节, 每节都是可直接运行的 Typescript 文件.

## Usage

1. 初始化 workspace

```
mkdir ./workspace
cp -r ./workspace_template/ ./workspace/
```

2. 运行

```
pnpm install
npx tsx ./src/core.ts
```

### 打包

如果你想要一个可执行文件，可以用 bun 打包

```
bash ./scripts/build-bun.sh
```

### 调试 Debugging

推荐用这个: https://github.com/lenML/llmid

---

## 这是什么?

大多数 Agent 教程停在"调一次 API"就结束了. 这个仓库从那个 while 循环开始, 一路带你到生产级网关.

逐章节构建一个最小化 AI Agent 网关. 7 个章节, 7 个核心概念, 约 7,000 行 Typescript. 每节只引入一个新概念, 前一节的代码原样保留. 学完全部 7 节, 你就能顺畅地阅读 OpenClaw 的生产代码.

```sh
s01: Agent Loop           -- 基础: while + stop_reason
s02: Tool Use             -- 让模型能调工具: dispatch table
s03: Sessions & Context   -- 会话持久化, 上下文溢出处理
s04: Channels             -- Telegram + 飞书: 完整通道管线
s05: Gateway & Routing    -- 5 级绑定, 会话隔离
s06: Intelligence         -- 灵魂, 记忆, 技能, 提示词组装
s07: Heartbeat & Cron     -- 主动型 Agent + 定时任务
```

## 架构概览

```
+------------------- claw0 layers -------------------+
|                                                     |
|  s07: Heartbeat    (Lane 锁, cron 调度)             |
|  s06: Intelligence (8 层提示词, 混合记忆检索)       |
|  s05: Gateway      (WebSocket, 5 级路由)            |
|  s04: Channels     (Telegram 管线, 飞书 webhook)    |
|  s03: Sessions     (JSONL 持久化, 3 阶段重试)       |
|  s02: Tools        (dispatch table, 4 个工具)       |
|  s01: Agent Loop   (while True + stop_reason)       |
|                                                     |
+-----------------------------------------------------+
```

## 章节依赖关系

```
s01 --> s02 --> s03 --> s04 --> s05
                 |               |
                 v               v
                s06 ----------> s07
```

- s01-s02: 基础 (无依赖)
- s03: 基于 s02 (为工具循环添加持久化)
- s04: 基于 s03 (通道产生 InboundMessage 给会话)
- s05: 基于 s04 (将通道消息路由到 Agent)
- s06: 基于 s03 (使用会话做上下文, 添加提示词层)
- s07: 基于 s06 (心跳使用灵魂/记忆构建提示词)

## 仓库结构

```
claw0/
  README.md              README
  .env.example           配置模板
  package.json           nodejs 配置
  sessions/              所有教学章节 (代码 + 文档)
    zh/                  中文
      s01_agent_loop.py  s01_agent_loop.md
      ...                ( .ts + .md)
  workspace/             共享工作区样例
    SOUL.md  IDENTITY.md  TOOLS.md  USER.md
    HEARTBEAT.md  BOOTSTRAP.md  AGENTS.md  MEMORY.md
    CRON.json
    skills/example-skill/SKILL.md
```

每个语言文件夹自包含: 可运行的 Typescript 代码 + 配套文档. 代码逻辑跨语言一致, 注释和文档因语言而异.

## 相关项目

- **[learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)**
- **[claw0](https://github.com/shareAI-lab/claw0)**

## 许可证

MIT
