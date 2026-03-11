# Memory Agent 集成方案

> 基于 Aria 记忆系统 v0.2 讨论纪要，结合 HappyClaw 现有架构的实现提案。

---

## 一、架构概览

```
用户会话 A (私聊, folder=home-{userId})  ──→ 主 Agent (Opus)
用户会话 B (群聊1, folder=xxx)           ──→ 主 Agent (Opus)
用户会话 C (群聊2, folder=yyy)           ──→ 主 Agent (Opus)
                                                │
                                    memory_query / session 结束
                                                │
                                                ↓
                                     Memory Agent Manager
                                      (src/memory-agent.ts)
                                                │
                                                ↓
                                Memory Agent (Sonnet, per-user 单例)
                                     工作目录: data/memory/{userId}/
                                     ├── index.md          随身索引
                                     ├── knowledge/        检索知识
                                     ├── impressions/      模糊印象
                                     ├── transcripts/      原始记录
                                     ├── personality.md    性格线
                                     └── state.json        元数据
```

### 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Memory Agent 运行形态 | 宿主机子进程（不复用 agent-runner） | 更简单的 stdin/stdout 协议，不需要 IPC 文件和 session loop |
| 模型 | Sonnet | 记忆整理不需要 Opus 的推理深度 |
| 进程生命周期 | 长驻 + 空闲超时 | 避免每次查询的冷启动开销 |
| Agent 间通信 | HTTP 内部端点 + stdin/stdout 管道 | 同步调用，明确的错误语义，零轮询 |
| 并发模型 | 每用户一个 Memory Agent，串行处理 | 唯一写入者，天然无冲突 |
| 与旧记忆系统关系 | 完全独立，通过用户级开关切换 | 两套系统不共享存储和代码路径 |

---

## 二、新旧记忆系统开关

### 2.1 配置

用户级配置，存储在 `data/config/user-im/{userId}/memory.json`（复用现有 per-user 配置目录）：

```json
{
  "memoryMode": "legacy"
}
```

| 值 | 行为 |
|----|------|
| `"legacy"`（默认） | 使用现有记忆系统（CLAUDE.md + memory_search/get/append） |
| `"agent"` | 使用新 Memory Agent 系统 |

### 2.2 隔离保证

两套系统**完全独立**，互不干扰：

| 维度 | 旧系统 | 新系统 |
|------|--------|--------|
| 存储目录 | `data/groups/user-global/{userId}/` + `data/memory/{folder}/` | `data/memory/{userId}/`（注意：旧系统的 `data/memory/` 按 folder 组织，新系统按 userId 组织，路径不冲突） |
| MCP 工具 | `memory_search` / `memory_get` / `memory_append` | `memory_query` / `memory_remember` |
| systemPrompt 注入 | 全局 CLAUDE.md + HEARTBEAT.md + 记忆工具说明 | index.md + 新记忆工具说明 |
| 后台维护 | daily-summary（凌晨汇总） | Memory Agent 会话收尾 + 全局睡眠 |
| 挂载路径 | `WORKSPACE_GLOBAL` → user-global dir（读写） | `WORKSPACE_GLOBAL` → memory dir（只读） |

### 2.3 切换入口

- **API**：`PUT /api/config/user-im/memory`（复用现有 per-user 配置路由模式）
- **前端**：设置页 → 记忆系统 → 选择模式
- **生效时机**：下次启动会话时生效（不影响运行中的会话）

### 2.4 代码分支点

agent-runner 启动时根据 `HAPPYCLAW_MEMORY_MODE` 环境变量决定行为：

```typescript
const MEMORY_MODE = process.env.HAPPYCLAW_MEMORY_MODE || 'legacy';

if (MEMORY_MODE === 'agent') {
  // 注册 memory_query / memory_remember MCP 工具（使用 ctx.userId，见 §8.1-8.2）
  // systemPrompt 从 /workspace/memory-index/index.md 注入（见 §8.3）
  // 不注册 memory_search / memory_get / memory_append
} else {
  // 现有逻辑不变
}
```

主进程侧同理：启动容器/进程时读取用户配置，设置对应的环境变量和挂载路径。

---

## 三、通信架构：HTTP + stdin/stdout

### 3.1 为什么不用 IPC 文件轮询

IPC 文件轮询（现有 install_skill 模式）的问题：**沉默是模糊的**。

agent-runner 的 MCP 工具写了请求文件，然后每 500ms 轮询响应文件——在这期间，它无法区分：
- 主进程还没读到请求（IPC 轮询 1s 间隔）
- Memory Agent 正在处理
- Memory Agent 进程挂了
- 主进程挂了

只能用粗暴的超时兜底。

### 3.2 新方案：两段同步通信

```
主 Agent (agent-runner)                    主进程 (Hono)                    Memory Agent (子进程)
       │                                       │                                  │
       │  HTTP POST /internal/memory/query      │                                  │
       │──────────────────────────────────────→  │                                  │
       │  (同步阻塞，等 HTTP 响应)               │  stdin: 写入查询 JSON             │
       │                                       │────────────────────────────────→  │
       │                                       │  (等 stdout 响应)                 │
       │                                       │                                  │  SDK query()
       │                                       │                                  │  Grep/Read 文件
       │                                       │                                  │  组织回复
       │                                       │                                  │
       │                                       │  stdout: 响应 JSON               │
       │                                       │←────────────────────────────────  │
       │  HTTP 200 + response body             │                                  │
       │←──────────────────────────────────────  │                                  │
       │                                       │                                  │
```

**第一段**：agent-runner → 主进程（HTTP）
- agent-runner 的 MCP 工具直接 `fetch()` 调用主进程的内部端点
- 同步阻塞等待 HTTP 响应
- HTTP 状态码提供明确的错误语义

**第二段**：主进程 → Memory Agent（stdin/stdout 管道）
- 主进程 `spawn()` Memory Agent 子进程，持有 stdin/stdout 管道
- 写查询到 stdin → 立即送达（操作系统管道，零延迟）
- 读响应从 stdout → 进程 exit 事件立即感知崩溃

### 3.3 错误语义

```
HTTP 200              → 查询完成（响应在 body 中，可能是 "没有找到相关记忆"）
HTTP 408              → Memory Agent 处理超时（30 秒内未返回结果）
HTTP 502              → Memory Agent 进程崩溃（stdout 意外关闭）
HTTP 503              → Memory Agent 正忙（该用户的上一个请求还在处理）
Connection refused    → 主进程不可用
```

MCP 工具可以根据不同状态返回不同的用户友好提示：
- 200 → 正常返回结果
- 408 → "记忆系统暂时忙不过来，你可以直接告诉我相关信息"
- 502 → "记忆系统出了点问题，不过不影响我们继续聊"
- 503 → "上一个记忆查询还在处理中，稍等一下"

### 3.4 内部 HTTP 端点

在主进程的 Hono 路由中新增（`src/routes/memory-agent.ts`）：

```
POST /api/internal/memory/query
  Authorization: Bearer {HAPPYCLAW_INTERNAL_TOKEN}
  Body: { "userId": "xxx", "query": "...", "context": "..." }
  Response: { "response": "...", "found": true }

POST /api/internal/memory/remember
  Authorization: Bearer {HAPPYCLAW_INTERNAL_TOKEN}
  Body: { "userId": "xxx", "content": "...", "importance": "high" }
  Response: { "accepted": true }

POST /api/internal/memory/session-wrapup
  Authorization: Bearer {HAPPYCLAW_INTERNAL_TOKEN}
  Body: { "userId": "xxx", "transcriptFile": "...", "groupFolder": "..." }
  Response: { "accepted": true }
```

**认证**：简单的 Bearer Token，主进程启动时生成，通过环境变量 `HAPPYCLAW_INTERNAL_TOKEN` 传给所有 agent-runner。只接受本机请求。

### 3.5 agent-runner 侧的 HTTP 调用

```typescript
// 环境变量（由 container-runner 设置）
const API_URL = process.env.HAPPYCLAW_API_URL;       // http://localhost:3000 或 http://host.docker.internal:3000
const API_TOKEN = process.env.HAPPYCLAW_INTERNAL_TOKEN;

async function callMemoryAgent(path: string, body: object): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000); // 略大于服务端超时

  try {
    const res = await fetch(`${API_URL}/api/internal/memory${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const status = res.status;
      if (status === 408) return { error: 'timeout', message: '记忆系统处理超时' };
      if (status === 502) return { error: 'crashed', message: '记忆系统暂时不可用' };
      if (status === 503) return { error: 'busy', message: '记忆系统正忙' };
      return { error: 'unknown', message: `记忆系统错误 (${status})` };
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'timeout', message: '请求超时' };
    return { error: 'network', message: '无法连接记忆系统' };
  } finally {
    clearTimeout(timeout);
  }
}
```

---

## 四、Memory Agent 进程模型

### 4.1 不复用 agent-runner，写一个轻量的 memory-agent-runner

**理由**：agent-runner 为对话场景设计（ContainerInput stdin 协议、IPC 文件轮询、OUTPUT_MARKER 输出协议、MCP 工具注册、PreCompact Hook 等），Memory Agent 不需要这些。硬塞进去反而增加复杂度。

Memory Agent 是一个独立的简单 Node.js 脚本：

```
container/memory-agent/
  ├── package.json              # 依赖：@anthropic-ai/claude-agent-sdk
  ├── tsconfig.json
  └── src/
      └── index.ts              # ~200 行，stdin/stdout 协议
```

### 4.2 核心逻辑

```typescript
// container/memory-agent/src/index.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const MEMORY_DIR = process.env.HAPPYCLAW_MEMORY_DIR!;
const SYSTEM_PROMPT = buildSystemPrompt();

// 逐行读取 stdin
const rl = readline.createInterface({ input: process.stdin });

for await (const line of rl) {
  const request = JSON.parse(line);

  try {
    // 构建 prompt（根据请求类型不同）
    const prompt = buildPrompt(request);

    // 调用 Claude SDK — Memory Agent 自己就是一个 Claude Code 实例
    const result = await query({
      prompt,
      options: {
        model: 'claude-sonnet-4-6',
        cwd: MEMORY_DIR,
        systemPrompt: SYSTEM_PROMPT,
        maxTurns: 15,                        // 限制工具调用轮次
        permissionMode: 'bypassPermissions', // 信任所有工具调用
        allowedTools: [...],                 // Read, Write, Edit, Grep, Glob
      },
    });

    // 提取最终文本，写到 stdout
    const response = extractFinalText(result);
    process.stdout.write(JSON.stringify({
      requestId: request.requestId,
      success: true,
      response,
    }) + '\n');

  } catch (err) {
    process.stdout.write(JSON.stringify({
      requestId: request.requestId,
      success: false,
      error: err.message,
    }) + '\n');
  }
}
```

### 4.3 主进程侧的管理

```typescript
// src/memory-agent.ts
class MemoryAgentManager {
  // per-user 子进程
  private processes: Map<string, {
    proc: ChildProcess;
    pendingQueries: Map<string, { resolve, reject, timeout }>;
    lastActivity: number;
    outputBuffer: string;
  }> = new Map();

  // 启动 Memory Agent 子进程
  private startAgent(userId: string): ChildProcess {
    const memDir = path.join(DATA_DIR, 'memory', userId);
    const proc = spawn('node', [MEMORY_AGENT_DIST], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HAPPYCLAW_MEMORY_DIR: memDir,
        ANTHROPIC_API_KEY: getApiKey(),
        HAPPYCLAW_MODEL: 'sonnet',
      },
      cwd: memDir,
    });

    // stdout 逐行读取 → 路由到 pending promise
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      const pending = entry.pendingQueries.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(msg);
        entry.pendingQueries.delete(msg.requestId);
      }
    });

    // 进程崩溃 → reject 所有 pending queries
    proc.on('exit', (code) => {
      const entry = this.processes.get(userId);
      if (entry) {
        for (const [id, pending] of entry.pendingQueries) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`Memory Agent exited (code ${code})`));
        }
        this.processes.delete(userId);
      }
    });

    return proc;
  }

  // 同步查询（返回 Promise）
  async query(userId: string, queryText: string, context?: string): Promise<MemoryResponse> {
    const entry = this.ensureAgent(userId);
    const requestId = generateId();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        entry.pendingQueries.delete(requestId);
        reject(new Error('Memory query timeout'));
      }, 30000);

      entry.pendingQueries.set(requestId, { resolve, reject, timeout });

      // 写到 stdin — 立即送达，零延迟
      entry.proc.stdin.write(JSON.stringify({
        requestId,
        type: 'query',
        query: queryText,
        context,
      }) + '\n');
    });
  }

  // fire-and-forget：记住 / 会话收尾 / 全局睡眠
  async send(userId: string, message: object): Promise<void> {
    const entry = this.ensureAgent(userId);
    entry.proc.stdin.write(JSON.stringify(message) + '\n');
    entry.lastActivity = Date.now();
  }

  // 空闲超时检查（定期调用）
  checkIdleAgents(): void {
    const IDLE_TIMEOUT = 10 * 60 * 1000;
    for (const [userId, entry] of this.processes) {
      if (Date.now() - entry.lastActivity > IDLE_TIMEOUT && entry.pendingQueries.size === 0) {
        entry.proc.stdin.end(); // 优雅关闭
        this.processes.delete(userId);
      }
    }
  }
}
```

### 4.4 关键行为

| 场景 | 行为 |
|------|------|
| 首次查询 | 启动子进程 → 冷启动（~2s SDK 初始化 + LLM 调用） |
| 后续查询（进程存活） | 直接写 stdin → 热启动（无额外开销） |
| 进程崩溃 | 所有 pending queries reject → 下次查询自动重启 |
| 空闲 10 分钟 | 优雅关闭 stdin → 进程自然退出 |
| 并发查询同一用户 | 串行处理（SDK query() 是顺序执行的） |
| 并发查询不同用户 | 并行（不同子进程） |

### 4.5 并发控制

```typescript
const MAX_CONCURRENT_MEMORY_AGENTS = 3; // 独立限制，不占主 Agent 配额
```

超出限制时排队等待，不拒绝。

---

## 五、存储设计

### 5.1 目录结构

```
data/memory/{userId}/
  ├── index.md                           # 随身索引（~200 条，分区管理）
  ├── knowledge/                         # 检索知识（第二层）
  │   ├── user-profile.md                # 用户档案
  │   ├── preferences.md                 # 偏好设定
  │   ├── projects/                      # 按项目分目录
  │   │   ├── defi-lending.md
  │   │   └── memory-system.md
  │   └── people/                        # 群聊中认识的人
  │       ├── tech-group-a.md
  │       └── ...
  ├── impressions/                       # 模糊印象（第三层，语义索引文件）
  │   ├── 2026-03-07-memory-design.md
  │   ├── 2026-03-08-go-generics.md
  │   └── ...
  ├── transcripts/                       # 原始记录（第四层）
  │   ├── 2026-03-07/
  │   │   ├── home-user1-session1.md
  │   │   └── group-xxx-session1.md
  │   └── 2026-03-08/
  │       └── ...
  ├── personality.md                     # 性格线（行为指令调整记录）
  └── state.json                         # 元数据
```

### 5.2 state.json

`lastSessionWrapups` 使用 `MessageCursor`（`{ timestamp, id }` 元组）而非简单时间戳，与 `db.getMessagesSince()` 的接口对齐：

```json
{
  "lastGlobalSleep": "2026-03-11T02:15:00Z",
  "lastSessionWrapups": {
    "web:home-user1": { "timestamp": "2026-03-11T18:30:00Z", "id": "msg_abc123" },
    "feishu:oc_xxx": { "timestamp": "2026-03-10T14:20:00Z", "id": "msg_def456" }
  },
  "pendingWrapups": ["group-xxx"],
  "indexVersion": 42,
  "totalImpressions": 156,
  "totalKnowledgeFiles": 23
}
```

### 5.3 与现有记忆目录的关系

两套系统**完全独立**，存储路径不冲突：

| 旧系统目录 | 新系统目录 | 关系 |
|-----------|-----------|------|
| `data/groups/user-global/{userId}/CLAUDE.md` | `data/memory/{userId}/knowledge/user-profile.md` | 无关。切换到新系统时可选导入 |
| `data/groups/user-global/{userId}/daily-summary/` | `data/memory/{userId}/impressions/` | 无关。新系统自行生成 |
| `data/groups/user-global/{userId}/HEARTBEAT.md` | `data/memory/{userId}/index.md` | 无关。被随身索引替代 |
| `data/memory/{folder}/YYYY-MM-DD.md`（旧日期记忆） | `data/memory/{userId}/knowledge/` | 路径不冲突（旧按 folder，新按 userId） |
| `data/groups/{folder}/conversations/` | `data/memory/{userId}/transcripts/` | 无关。新系统由主进程导出 |

切换回旧系统时，旧数据仍然完好。切换到新系统时，可选择一次性导入旧数据。

---

## 六、触发机制

### 6.1 实时查询（memory_query）

```
用户提问 → 主 Agent 判断需要回忆
  → MCP 工具 memory_query
  → HTTP POST /api/internal/memory/query
  → MemoryAgentManager.query(userId, ...)
  → stdin → Memory Agent → stdout
  → HTTP 200 → MCP 工具返回
```

### 6.2 主动记忆（memory_remember）

```
用户说 "记住这个" → 主 Agent 识别意图
  → MCP 工具 memory_remember
  → HTTP POST /api/internal/memory/remember
  → MemoryAgentManager.send(userId, { type: 'remember', ... })
  → 主 Agent 立即收到确认（不等 Memory Agent 处理完）
  → Memory Agent 异步处理（写入 knowledge/，更新 index.md）
```

### 6.3 会话收尾（session_wrapup）

```
容器/进程空闲超时关闭
  → GroupQueue.onContainerExit listener（见第七章）
  → getJidsByFolder(folder) 获取所有关联的 chatJid
  → exportTranscripts(userId, folder, chatJids)
    → 遍历所有 chatJid，用 cursor 查询自上次收尾以来的新消息
    → 合并排序，写入 data/memory/{userId}/transcripts/{date}/{folder}-{ts}.md
    → 更新所有 chatJid 的 cursor 到 state.json
  → MemoryAgentManager.send(userId, { type: 'session_wrapup', ... })
  → Memory Agent 异步处理：
    → 读取 transcript
    → 生成语义索引文件 → impressions/
    → 提炼知识 → knowledge/
    → 更新 index.md 近期上下文区
```

### 6.4 凌晨全局睡眠（global_sleep）

```
task-scheduler 凌晨 2-3 点检查（紧接 daily-summary 之后）
  → 遍历所有启用了新记忆系统的用户
  → 对每个用户：
    → 检查 state.json.lastGlobalSleep 距今 > 20 小时？
    → 检查该用户没有活跃会话？
    → 检查有未整理的 pendingWrapups？
    → 三个条件都满足 → MemoryAgentManager.send(userId, { type: 'global_sleep' })
  → Memory Agent 执行：
    → compact index.md
    → 过期清理
    → 自审
    → 性格线分析（更新 personality.md）
    → 更新 state.json
```

---

## 七、前置改动：GroupQueue 多回调支持

### 7.0 问题

当前 `GroupQueue.setOnContainerExit()` 只支持一个回调（`web.ts` 已占用，用于终端清理）。Memory Agent 的 transcript 导出也需要挂载到容器退出事件上。

### 7.0.1 改造方案

将单回调改为 listener 数组：

```typescript
// src/group-queue.ts
// 改前：
private onContainerExitFn: ((groupJid: string) => void) | null = null;
setOnContainerExit(fn: (groupJid: string) => void): void {
  this.onContainerExitFn = fn;
}
// 调用处：
this.onContainerExitFn?.(groupJid);

// 改后：
private onContainerExitListeners: Array<(groupJid: string) => void> = [];
addOnContainerExitListener(fn: (groupJid: string) => void): void {
  this.onContainerExitListeners.push(fn);
}
// 调用处：
for (const fn of this.onContainerExitListeners) {
  try { fn(groupJid); } catch (err) {
    logger.error({ groupJid, err }, 'onContainerExit listener failed');
  }
}
```

涉及文件：`src/group-queue.ts`（定义）、`src/web.ts`（终端清理 → 改为 `addOnContainerExitListener`）、`src/index.ts`（新增 transcript 导出 listener）。

---

## 八、主 Agent 侧改动

### 8.1 ContainerInput 新增 userId 字段

现有 `ContainerInput`（`container/agent-runner/src/types.ts`）中没有 `userId`，但新记忆工具的 HTTP 调用需要它。

```typescript
// container/agent-runner/src/types.ts
export interface ContainerInput {
  // ...existing fields...
  /** Owner user ID. Required for memory_query / memory_remember. */
  userId?: string;
}
```

`container-runner.ts` 构建 `ContainerInput` JSON 时，从 `group.created_by` 取值填入。

### 8.2 新增 MCP 工具

在 `container/agent-runner/src/mcp-tools.ts` 中，仅当 `MEMORY_MODE === 'agent'` 时注册。

`ctx.userId` 来自 `ContainerInput.userId`（由 container-runner 从 `group.created_by` 填入，见 8.1）：

**memory_query**：

```typescript
tool('memory_query', {
  description: '向记忆系统查询。可以问关于过去对话、用户信息、项目知识的任何问题。',
  parameters: {
    query: { type: 'string', description: '查询内容' },
    context: { type: 'string', description: '当前对话的简要上下文', optional: true },
  },
  handler: async ({ query, context }) => {
    const result = await callMemoryAgent('/query', {
      userId: ctx.userId,
      query,
      context,
    });
    if (result.error) return { isError: true, text: result.message };
    return { text: result.response };
  },
});
```

**memory_remember**：

```typescript
tool('memory_remember', {
  description: '告诉记忆系统记住某条信息。用户说"记住"或发现重要信息时使用。',
  parameters: {
    content: { type: 'string', description: '需要记住的内容' },
    importance: { type: 'string', enum: ['high', 'normal'], optional: true },
  },
  handler: async ({ content, importance }) => {
    await callMemoryAgent('/remember', {
      userId: ctx.userId,
      content,
      importance: importance || 'normal',
    });
    return { text: '已通知记忆系统。' };
  },
});
```

### 8.3 随身索引注入 systemPrompt

新系统下，`buildMemoryRecallPrompt()` 改为读取 `data/memory/{userId}/index.md`。

**重要**：不能复用 `/workspace/global` 挂载点。现有代码中 agent-runner 的记忆归档逻辑会读写 `/workspace/global/CLAUDE.md`，如果新模式下把这个路径指向只读的 `data/memory/{userId}/`，会导致写操作静默失败。

使用独立挂载点 `/workspace/memory-index/`：

```
主容器启动时（新记忆模式）：
  /workspace/global      → data/groups/user-global/{userId}/  （保持不变，读写）
  /workspace/memory-index → data/memory/{userId}/              （新增，只读）
```

agent-runner 检测到 `MEMORY_MODE === 'agent'` 时，从 `/workspace/memory-index/index.md` 读取随身索引注入 systemPrompt。旧记忆系统的 `/workspace/global` 路径行为不受影响。

对应 container-runner 改动：

```typescript
// src/container-runner.ts buildVolumeMounts()
if (memoryMode === 'agent' && ownerId) {
  const memoryDir = path.join(DATA_DIR, 'memory', ownerId);
  mkdirForContainer(memoryDir);
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/memory-index',
    readonly: true,
  });
}

// 宿主机模式同理：
if (memoryMode === 'agent' && ownerId) {
  hostEnv['HAPPYCLAW_WORKSPACE_MEMORY_INDEX'] = path.join(DATA_DIR, 'memory', ownerId);
}
```

### 8.4 systemPrompt 中的记忆说明

旧系统的记忆说明替换为：

```markdown
## 记忆系统

你的随身索引已加载（见上方），包含你"知道什么"的概要。

- 需要回忆过去的对话、查找用户信息、确认某件事 → `memory_query`
- 用户说"记住"或发现重要信息 → `memory_remember`
- 不要自己修改记忆文件，记忆由专门的系统管理

memory_query 可能需要几秒钟。查询时可以先告诉用户"让我想想……"。
```

---

## 九、Memory Agent 的 System Prompt

完整版另行维护，核心结构：

```markdown
你是一个记忆管理系统。你的职责是管理和维护用户的长期记忆。

## 你的工作目录
- index.md — 随身索引（主 Agent 每次对话自动加载的摘要，~200 条上限）
- knowledge/ — 按领域组织的详细知识
- impressions/ — 按会话组织的语义索引文件（话题、关键词、涉及的人/事/概念）
- transcripts/ — 原始对话记录（source of truth）
- personality.md — 用户交互风格记录
- state.json — 系统元数据

## 请求类型

### query — 回忆查询
处理流程：
1. Grep index.md 快速查找
2. 没命中 → Grep impressions/ 语义索引文件
3. 命中 → Read knowledge/ 或 transcripts/ 获取细节
4. 组织自然语言回复，包含来源和时间
5. **索引自我修复**（在回复之后、同一次 query 处理中执行）：
   - 如果第 1 层没命中但第 2/3 层命中了 → 回去检查 impressions/ 对应的索引文件，补充缺失的关键词/关联词，让下次同类查询更容易命中
   - 如果第 2 层命中但展开后发现实际不相关（误命中）→ 修正该索引文件中导致误命中的关键词，减少噪音
   - 如果最终从 transcripts/ 找到了有价值的内容但 knowledge/ 里没有 → 顺手提炼写入 knowledge/，更新 index.md 索引

### remember — 记住信息
1. 判断信息类型（用户身份/偏好/项目知识/临时提醒）
2. 写入对应的 knowledge/ 文件（检查冲突，自述优先）
3. 更新 index.md（加一行索引，不放具体内容）

### session_wrapup — 会话收尾
1. 读取 transcripts/ 中的新对话记录
2. 生成语义索引文件 → impressions/
3. 提炼知识 → knowledge/（检查冲突）
4. 更新 index.md 近期上下文区
5. **交叉修复**：如果本次对话中引用了旧记忆（比如用户说"上次聊的那个"），检查对应的旧 impressions 索引文件，补充本次对话暴露出的缺失关联

### global_sleep — 全局维护
1. compact index.md（合并、降级低热度、精简）
2. 过期清理（已过时的提醒）
3. 自审（分区比例、去重、内容错放）
4. 更新 personality.md（分析交互模式）

## 索引自我修复

类似人类的记忆强化——回忆一次后关联路径变多，下次更容易想起来。

修复发生在 query 处理的尾声（不阻塞回复），三种情况：

| 信号 | 动作 | 示例 |
|------|------|------|
| 命中了但索引层没覆盖 | 补充索引文件的关键词/关联词 | 搜"Qdrant"在 impressions 命中，但该索引文件的关键词里没有"Qdrant" → 补上 |
| 搜到了但实际不相关 | 修正索引文件，移除/弱化误导词 | 搜"借贷"命中了一个聊天记录，但那次只是顺嘴提了一句 → 从关键词里移除"借贷" |
| 深层有料但浅层没索引 | 提炼写入 knowledge/ + 更新 index.md | transcripts 里找到了用户详述的技术方案，但 knowledge/ 没有 → 提炼写入 |

原则：
- 每次 query 最多修复 1-2 个索引文件，不要大规模重写
- 修复是"微调"不是"重建"——加几个关键词、删一个误导词、补一条索引
- 如果修复量较大（比如发现某个索引文件质量很差），记录到 state.json 的 pendingMaintenance，留给 global_sleep 处理

## 硬规则
- 时间绝对化：所有写入的时间转为绝对时间，保留记录时间和事件时间
- 随身索引只放索引不放内容，超限触发 compact 不触发丢弃
- 可信度：自述优先原则——自己说自己的最可信，第三方转述标注来源、不覆盖自述
- index.md 分区：关于用户(~30) / 活跃话题(~50) / 重要提醒(~20) / 近期上下文(~50) / 备用(~50)
```

---

## 十、Transcript 导出

### 10.1 触发时机

容器/进程关闭时（空闲超时 or 手动关闭），通过 `queue.addOnContainerExitListener()` 挂载回调（见第七章）。

### 10.2 一个 folder 对应多个 chatJid

HappyClaw 支持多个 IM 群映射到同一个 folder（如飞书群 + Telegram 群 + Web 都指向 `home-{userId}`）。容器退出时需要导出**所有关联 chatJid** 的消息。

使用已有的 `db.getJidsByFolder(folder)` 获取所有 JID：

```typescript
// src/index.ts — 注册 transcript 导出 listener
queue.addOnContainerExitListener((groupJid: string) => {
  const group = getRegisteredGroup(groupJid);
  if (!group?.is_home || !group.created_by) return;

  const memoryMode = getUserMemoryMode(group.created_by);
  if (memoryMode !== 'agent') return;

  const allJids = getJidsByFolder(group.folder);
  exportTranscripts(group.created_by, group.folder, allJids);
});
```

### 10.3 导出逻辑

**注意**：现有 `db.getMessagesSince()` 使用 `MessageCursor`（`{ timestamp, id }` 元组），不是 ISO 时间字符串。`state.json` 中的游标存储也需要对齐：

```typescript
// state.json 中的 lastSessionWrapups 改为存 cursor
{
  "lastSessionWrapups": {
    "home-user1": { "timestamp": "2026-03-11T18:30:00Z", "id": "msg_abc123" },
    "group-xxx": { "timestamp": "2026-03-10T14:20:00Z", "id": "msg_def456" }
  }
}
```

```typescript
async function exportTranscripts(userId: string, folder: string, chatJids: string[]) {
  const state = readMemoryState(userId);
  const defaultCursor = { timestamp: '1970-01-01T00:00:00Z', id: '' };

  // 收集所有关联 chatJid 的新消息
  let allMessages: NewMessage[] = [];
  for (const jid of chatJids) {
    const cursor = state.lastSessionWrapups[jid] || defaultCursor;
    const msgs = db.getMessagesSince(jid, cursor);
    allMessages.push(...msgs);
  }

  if (allMessages.length === 0) return;

  // 按时间排序，合并为一份 transcript
  allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));

  const md = formatTranscriptMarkdown(allMessages, folder);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${folder}-${Date.now()}.md`;
  const transcriptPath = path.join('transcripts', dateStr, filename);
  const fullPath = path.join(DATA_DIR, 'memory', userId, transcriptPath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  atomicWriteSync(fullPath, md);

  // 更新所有 chatJid 的游标到最后一条消息
  const lastMsg = allMessages[allMessages.length - 1];
  for (const jid of chatJids) {
    state.lastSessionWrapups[jid] = { timestamp: lastMsg.timestamp, id: lastMsg.id };
  }
  writeMemoryState(userId, state);

  memoryAgentManager.send(userId, {
    type: 'session_wrapup',
    transcriptFile: transcriptPath,
    groupFolder: folder,
    chatJids,  // 改为数组，告知 Memory Agent 涉及哪些渠道
  });
}
```

### 10.4 Transcript 格式

```markdown
# 对话记录 — home-user1
时间范围：2026-03-11 14:00 ~ 18:30
消息数：23

---

**User** (2026-03-11 14:02): 帮我看看这个 DeFi 借贷协议的设计

**Agent** (2026-03-11 14:03): 好的，让我看看...

**User** (2026-03-11 14:15): 对了，记住我下周三（2026-03-18）要去东京出差

**Agent** (2026-03-11 14:15): 好的，已记录。

...
```

---

## 十一、需要修改/新增的文件

### 新增

| 文件 | 职责 |
|------|------|
| `container/memory-agent/` | Memory Agent 独立项目（package.json + src/index.ts） |
| `src/memory-agent.ts` | MemoryAgentManager：per-user 进程管理、查询路由、stdin/stdout 通信 |
| `src/routes/memory-agent.ts` | 内部 HTTP 端点（/api/internal/memory/*） |

### 修改

| 文件 | 改动 |
|------|------|
| `src/group-queue.ts` | `setOnContainerExit` → `addOnContainerExitListener`（多回调支持） |
| `src/web.ts` | 终端清理改为 `addOnContainerExitListener` |
| `container/agent-runner/src/types.ts` | `ContainerInput` 新增 `userId` 字段 |
| `container/agent-runner/src/mcp-tools.ts` | 新增 `memory_query` / `memory_remember`（条件注册） |
| `container/agent-runner/src/index.ts` | `MEMORY_MODE` 分支：不同的 systemPrompt 和工具集 |
| `src/container-runner.ts` | `ContainerInput` 写入 `userId`；新增 `/workspace/memory-index` 挂载；`HAPPYCLAW_WORKSPACE_MEMORY_INDEX` 环境变量 |
| `src/index.ts` | 初始化 MemoryAgentManager；注册 transcript 导出 listener；idle check 中增加 Memory Agent 清理 |
| `src/task-scheduler.ts` | 凌晨全局睡眠触发 |
| `src/routes/config.ts` | 新增 `GET|PUT /api/config/user-im/memory`（记忆模式配置） |
| `container/entrypoint.sh` | `chown` 行增加 `/workspace/memory-index` |
| `Makefile` | 新增 memory-agent 构建目标 |

### 不改

| 文件 | 原因 |
|------|------|
| `src/db.ts` | `getMessagesSince()` 已存在（cursor 模式），无需新增 |
| `src/routes/memory.ts` | 旧记忆页面保持不变（两套独立） |
| `web/` | Phase 1 前端无需改动 |

---

## 十二、分阶段实现

### Phase 0：前置改动（无功能变化）

**目标**：修改基础设施，为 Memory Agent 铺路。可以单独提 PR，不影响现有行为。

1. `src/group-queue.ts` — `setOnContainerExit` → `addOnContainerExitListener`
2. `src/web.ts` — 终端清理适配新 API
3. `container/agent-runner/src/types.ts` — `ContainerInput` 新增 `userId` 字段
4. `src/container-runner.ts` — 构建 `ContainerInput` 时填入 `userId`

**验证**：现有功能不受影响，`make typecheck` 通过。

### Phase 1：核心通信链路

**目标**：Memory Agent 能启动、能查询、能回复。端到端验证通信架构。

1. `container/memory-agent/` — 独立项目，stdin/stdout 协议，SDK query()
2. `src/memory-agent.ts` — MemoryAgentManager（进程管理、Promise 路由）
3. `src/routes/memory-agent.ts` — 内部 HTTP 端点
4. `container/agent-runner/src/mcp-tools.ts` — `memory_query` 工具（HTTP 调用，使用 `ctx.userId`）
5. 存储目录初始化 + index.md 模板

**验证**：主 Agent 调 `memory_query("你好")` → Memory Agent 回复 → 主 Agent 收到。

### Phase 2：会话收尾 + 随身索引

**目标**：对话结束自动整理，新对话自动加载随身索引。

1. Transcript 导出（`addOnContainerExitListener` 挂载，遍历所有 chatJid）
2. session_wrapup 触发和处理
3. 随身索引注入 systemPrompt（`/workspace/memory-index/index.md`，独立挂载点）
4. `memory_remember` 工具
5. 新旧系统开关（配置 + 环境变量分支）

**验证**：聊天 → 空闲关闭 → Memory Agent 自动整理 → 新对话看到随身索引。

### Phase 3：全局睡眠 + 完善

**目标**：凌晨维护，索引容量可控，热度升降。

1. task-scheduler 全局睡眠触发
2. Memory Agent systemPrompt 完善（compact/清理/自审规则）
3. state.json 元数据维护

### Phase 4：性格线 + 前端适配

**目标**：性格演化，前端记忆页面适配。

1. personality.md → 注入主 Agent systemPrompt
2. Web 前端记忆页面支持新存储结构
3. 旧数据可选导入工具

---

## 十三、风险与缓解

| 风险 | 缓解 |
|------|------|
| Memory Agent LLM 调用失败 | HTTP 超时 + 优雅降级提示 |
| Memory Agent 进程崩溃 | process 'exit' 事件 → reject pending → 下次自动重启 |
| Compact 丢失关键信息 | compact 前备份 index.md（保留最近 3 版） |
| 性格线误判 | Phase 4 才上线；初期只记录不修改；需 20+ 次信号 |
| 随身索引被主 Agent 误改 | 只读挂载 |
| 存储增长 | transcripts 按月归档，6 个月以上可选清理 |
| 多查询排队延迟 | 串行处理 + 30s 超时 + 503 状态码告知调用方 |
| Docker 容器访问主进程 HTTP | `HAPPYCLAW_API_URL` 环境变量（host.docker.internal / localhost） |

---

## 十四、实现节奏与验收标准

> 基于代码审查结果，将原 §12 的四个阶段进一步细化为可独立验收的子步骤。每个步骤产出一个可合并的 PR。

### 总体原则

- **每步可独立提 PR**：不依赖后续步骤，不引入死代码
- **渐进式开关**：旧系统行为始终不受影响，新系统通过用户级开关启用
- **先通后优**：先跑通最小链路，再补充边界处理和优化
- **验收即测试**：每步列出的验收标准可直接转化为手动测试用例或自动化测试

---

### Phase 0：基础设施改造（无功能变化）

> 修改公共接口，为后续步骤铺路。可单独提 PR，合并后现有行为零变化。

#### 0-A：GroupQueue 多回调支持

**改动范围**：
- `src/group-queue.ts` — `setOnContainerExit()` → `addOnContainerExitListener()`，内部改为数组
- `src/web.ts` — 终端清理改用 `addOnContainerExitListener()`

**验收标准**：
1. `make typecheck` 通过
2. 启动系统，打开 Web 终端 → 容器退出 → 终端正常收到 `terminal_stopped` 消息
3. `setOnContainerExit` 在代码中已无调用点（`grep` 零命中）

#### 0-B：ContainerInput 新增 userId 字段

**改动范围**：
- `container/agent-runner/src/types.ts` — `ContainerInput` 新增 `userId?: string`
- `src/index.ts`（或 `processAgentMessages` 所在位置）— 构建 `ContainerInput` 时从 `group.created_by` 填入 `userId`
- `container/agent-runner/src/mcp-tools.ts` — `McpContext` 新增 `userId` 字段，从 `ContainerInput` 传入

**验收标准**：
1. `make typecheck` 通过（三个子项目）
2. 宿主机模式 + Docker 模式各跑一次对话，Agent 正常回复
3. 在 agent-runner 中 `console.error('userId:', ctx.userId)` 打印日志，确认 userId 正确传入（验完删除）

#### 0-C：用户级记忆模式配置

**改动范围**：
- `src/routes/config.ts` — 新增 `GET|PUT /api/config/user-im/memory`（复用 per-user 配置目录，存储 `data/config/user-im/{userId}/memory.json`）
- `src/runtime-config.ts`（或新文件）— `getUserMemoryMode(userId): 'legacy' | 'agent'`，fallback 默认 `'legacy'`

**验收标准**：
1. `curl PUT /api/config/user-im/memory -d '{"memoryMode":"agent"}'` → 200
2. `curl GET /api/config/user-im/memory` → `{"memoryMode":"agent"}`
3. 切回 `"legacy"` 后 `getUserMemoryMode()` 返回 `'legacy'`
4. 未配置的用户默认返回 `'legacy'`

---

### Phase 1：核心通信链路

> Memory Agent 能启动、能查询、能回复。端到端验证：主 Agent → HTTP → 主进程 → stdin → Memory Agent → stdout → HTTP → 主 Agent。

#### 1-A：Memory Agent 独立项目骨架

**改动范围**：
- 新建 `container/memory-agent/`：`package.json`（依赖 `@anthropic-ai/claude-agent-sdk`）、`tsconfig.json`、`src/index.ts`
- stdin 逐行读 JSON → 解析 → 调用 SDK `query()` → stdout 写 JSON 响应
- 支持的请求类型：`query`（其余类型先返回 `{ success: true, response: "not implemented" }`）
- `Makefile` — 新增 `build-memory-agent` 目标

**验收标准**：
1. `make build-memory-agent` 编译成功
2. 手动测试：`echo '{"requestId":"1","type":"query","query":"你好"}' | node container/memory-agent/dist/index.js`
   → stdout 输出包含 `requestId: "1"` 和 `success: true` 的 JSON
3. SDK 能正确调用 Sonnet 模型并返回自然语言响应
4. 无效 JSON 输入 → stderr 错误日志，进程不崩溃，继续等待下一行

#### 1-B：MemoryAgentManager 进程管理

**改动范围**：
- 新建 `src/memory-agent.ts` — `MemoryAgentManager` 类：
  - `ensureAgent(userId)` — 启动/复用子进程
  - `query(userId, query, context?)` — Promise 包装的 stdin/stdout 通信
  - `send(userId, message)` — fire-and-forget
  - `checkIdleAgents()` — 空闲超时关闭
  - `shutdownAll()` — 优雅关闭
- `src/index.ts` — 初始化 `MemoryAgentManager`，定期调用 `checkIdleAgents()`

**验收标准**：
1. `make typecheck` 通过
2. 单元测试或手动验证：
   - `manager.query('user1', '你好')` → 返回包含响应的 Promise
   - 同一 userId 第二次调用复用同一子进程（PID 相同）
   - 不同 userId 启动不同子进程
   - 进程崩溃后，pending query 的 Promise reject
   - 空闲超时后进程被关闭

#### 1-C：内部 HTTP 端点

**改动范围**：
- 新建 `src/routes/memory-agent.ts` — Hono 路由：
  - `POST /api/internal/memory/query` — 调用 `manager.query()`
  - `POST /api/internal/memory/remember` — 调用 `manager.send()`
  - `POST /api/internal/memory/session-wrapup` — 调用 `manager.send()`
- 认证：Bearer Token（`HAPPYCLAW_INTERNAL_TOKEN`，启动时生成随机值）
- `src/web.ts` — 注册路由

**验收标准**：
1. `curl -X POST http://localhost:3000/api/internal/memory/query -H 'Authorization: Bearer {token}' -d '{"userId":"xxx","query":"你好"}'` → 200 + 响应
2. 无 token → 401
3. 错误 token → 401
4. Memory Agent 超时 → 408
5. 不存在的 userId → 自动启动新进程 → 正常返回

#### 1-D：agent-runner 侧 MCP 工具（memory_query）

**改动范围**：
- `container/agent-runner/src/mcp-tools.ts` — 新增 `memory_query` 工具
  - 仅当 `HAPPYCLAW_MEMORY_MODE === 'agent'` 时注册
  - HTTP 调用主进程内部端点
  - 使用 `ctx.userId` 作为用户标识
- `src/container-runner.ts` — 根据 `getUserMemoryMode()` 设置 `HAPPYCLAW_MEMORY_MODE` 和 `HAPPYCLAW_INTERNAL_TOKEN` 环境变量

**验收标准**：
1. 用户设为 `memoryMode: 'agent'` → 新对话中 Agent 有 `memory_query` 工具可用
2. 用户设为 `memoryMode: 'legacy'`（默认） → Agent 没有 `memory_query` 工具，旧记忆工具正常
3. Agent 调用 `memory_query("你好")` → 返回 Memory Agent 的响应文本
4. 主进程不可达时 → 返回用户友好的错误提示，对话不中断

**Phase 1 整体里程碑**：
> 将 memoryMode 设为 `agent`，开启新对话，输入"调用 memory_query 查一下你记不记得什么"——Agent 调用工具 → Memory Agent 启动并回复 → Agent 展示结果。全链路走通。

---

### Phase 2：会话收尾 + 随身索引

> 对话结束自动整理记忆，新对话自动加载随身索引。

#### 2-A：存储目录初始化 + index.md 模板

**改动范围**：
- `src/memory-agent.ts` — `ensureMemoryDir(userId)` 函数：首次使用时创建目录结构 + 初始 index.md / state.json
- `container/memory-agent/src/index.ts` — 完善 systemPrompt（§9 中的核心结构）

**验收标准**：
1. 首次启动某用户的 Memory Agent 后，`data/memory/{userId}/` 目录结构完整
2. `index.md` 包含分区模板（关于用户 / 活跃话题 / 重要提醒 / 近期上下文 / 备用）
3. `state.json` 包含初始元数据

#### 2-B：Transcript 导出

**改动范围**：
- `src/index.ts` — 通过 `queue.addOnContainerExitListener()` 注册 transcript 导出回调
- 新增 `exportTranscripts(userId, folder, chatJids)` 函数（§10.3 逻辑）
- 调用 `db.getMessagesSince()` 获取新消息，合并排序，写入 `data/memory/{userId}/transcripts/`
- 更新 `state.json` 中的游标

**验收标准**：
1. 用户（memoryMode=agent）的主容器空闲超时关闭 → `data/memory/{userId}/transcripts/{date}/` 下生成 `.md` 文件
2. Transcript 内容包含该会话期间所有消息（用户 + Agent），按时间排序
3. 多 chatJid 映射到同一 folder 时，所有 JID 的消息都被导出
4. 重复触发（同一 folder 连续退出两次）→ 第二次不产生重复内容（游标正确推进）
5. 无新消息时 → 不生成空文件

#### 2-C：session_wrapup 触发

**改动范围**：
- `src/index.ts` — transcript 导出完成后，调用 `memoryAgentManager.send(userId, { type: 'session_wrapup', ... })`
- `container/memory-agent/src/index.ts` — 处理 `session_wrapup` 请求：
  - 读取 transcript 文件
  - 生成语义索引文件 → `impressions/`
  - 提炼知识 → `knowledge/`
  - 更新 `index.md` 近期上下文区

**验收标准**：
1. 容器退出 → Memory Agent 收到 session_wrapup 请求
2. `impressions/` 下生成对应的语义索引文件（包含话题、关键词等）
3. `index.md` 的"近期上下文"区有新增内容
4. 整理过程中 Memory Agent 不崩溃，错误写入 stderr 日志

#### 2-D：随身索引注入 systemPrompt

**改动范围**：
- `src/container-runner.ts` — 新增 `/workspace/memory-index` 挂载点（只读），指向 `data/memory/{userId}/`
- `container/agent-runner/src/index.ts` — 当 `MEMORY_MODE === 'agent'` 时，从 `/workspace/memory-index/index.md` 读取内容注入 systemPrompt
- systemPrompt 中添加记忆系统说明（§8.4）

**验收标准**：
1. 新对话启动 → Agent 的 systemPrompt 中包含 `index.md` 内容
2. `index.md` 不存在时 → 不崩溃，正常启动（无记忆注入）
3. `memoryMode: 'legacy'` 时 → 不注入，不影响旧系统
4. 挂载为只读 → Agent 写入 `/workspace/memory-index/` 失败（符合预期）

#### 2-E：memory_remember 工具

**改动范围**：
- `container/agent-runner/src/mcp-tools.ts` — 新增 `memory_remember` 工具（条件注册，同 memory_query）
- `src/routes/memory-agent.ts` — `/api/internal/memory/remember` 端点（已在 1-C 创建，补充实际逻辑）
- `container/memory-agent/src/index.ts` — 处理 `remember` 请求

**验收标准**：
1. 用户说"记住我下周要去出差" → Agent 调用 `memory_remember` → 返回"已通知记忆系统"
2. Memory Agent 将信息写入 `knowledge/` 对应文件
3. `index.md` 新增一行索引
4. 下次 `memory_query("出差")` 能查到

**Phase 2 整体里程碑**：
> 完整闭环：聊天（提到重要信息 + 主动"记住"）→ 空闲关闭 → transcript 导出 → Memory Agent 自动整理 → 新对话看到随身索引 → memory_query 能查到上次对话内容。

---

### Phase 3：全局睡眠 + 索引维护

> 凌晨自动维护，索引容量可控。

#### 3-A：global_sleep 触发

**改动范围**：
- `src/task-scheduler.ts`（或 `src/daily-summary.ts`）— 凌晨 2-3 点，遍历 `memoryMode=agent` 的用户，检查条件后触发 `memoryAgentManager.send(userId, { type: 'global_sleep' })`
- 条件：`lastGlobalSleep` > 20 小时、无活跃会话、有 pendingWrapups

**验收标准**：
1. 凌晨触发后，Memory Agent 日志显示收到 global_sleep 请求
2. 不满足条件时不触发（如用户有活跃容器）
3. 同一用户 20 小时内不重复触发

#### 3-B：Memory Agent global_sleep 处理

**改动范围**：
- `container/memory-agent/src/index.ts` — 完善 `global_sleep` 处理：
  - compact index.md（备份 → 合并低热度条目 → 降级）
  - 过期清理（已过时的提醒）
  - 自审（分区比例检查）
  - 更新 state.json

**验收标准**：
1. index.md 超过 200 条时 → compact 后降至合理范围
2. compact 前自动备份（`index.md.bak.1`，保留最近 3 版）
3. 过期提醒被清理
4. state.json 的 `lastGlobalSleep` 更新

#### 3-C：索引自我修复

**改动范围**：
- `container/memory-agent/src/index.ts` — 在 `query` 处理流程尾部增加自我修复逻辑（§9 中描述的三种情况）

**验收标准**：
1. 查询命中 impressions 但 index.md 没覆盖 → 自动补充关键词
2. 查询误命中 → 修正索引文件
3. 深层有料但浅层没索引 → 提炼写入 knowledge/
4. 每次修复最多 1-2 个文件，不大规模重写

**Phase 3 整体里程碑**：
> 系统运行一周后：index.md 容量稳定在合理范围；重复查询的命中率逐步提升；凌晨日志显示维护任务正常执行。

---

### Phase 4：性格线 + 前端 + 精打磨

> 完善用户体验和长期演化能力。

#### 4-A：personality.md 与性格线

**改动范围**：
- `container/memory-agent/src/index.ts` — global_sleep 中增加性格线分析
- `container/agent-runner/src/index.ts` — 随身索引注入时同时注入 `personality.md`

**验收标准**：
1. 20+ 次对话后，`personality.md` 中出现用户交互风格描述
2. 主 Agent 的 systemPrompt 包含 personality.md 内容
3. 性格线只记录不修改行为（不主动改变 Agent 说话方式）

#### 4-B：前端记忆页面适配

**改动范围**：
- `web/src/pages/MemoryPage.tsx` — 支持新存储结构的浏览和搜索
- `src/routes/memory.ts` — 新增适配新目录结构的 API

**验收标准**：
1. 前端能浏览 `index.md`、`knowledge/`、`impressions/` 的内容
2. 搜索功能覆盖新目录
3. 旧记忆系统用户看到的页面不变

#### 4-C：旧数据导入工具

**改动范围**：
- 新增脚本或 API — 读取旧系统的 `CLAUDE.md` + `daily-summary/` + `HEARTBEAT.md`，转换为新格式

**验收标准**：
1. 执行导入后，`knowledge/user-profile.md` 包含旧 CLAUDE.md 的核心内容
2. `impressions/` 包含旧 daily-summary 的语义索引
3. `index.md` 包含导入内容的索引
4. 导入可重复执行（幂等），不产生重复条目

**Phase 4 整体里程碑**：
> 从旧系统无缝迁移：导入旧数据 → 切换为 agent 模式 → 新对话中 Agent 能回忆旧数据的内容 → 前端可浏览和搜索所有记忆。

---

### 依赖关系图

```
Phase 0-A ──→ Phase 2-B（导出回调依赖多回调支持）
Phase 0-B ──→ Phase 1-D（MCP 工具依赖 ctx.userId）
Phase 0-C ──→ Phase 1-D（工具条件注册依赖模式配置）
              Phase 2-D（随身索引注入依赖模式判断）

Phase 1-A ──→ Phase 1-B（Manager 依赖 Agent 可执行文件）
Phase 1-B ──→ Phase 1-C（HTTP 端点依赖 Manager）
Phase 1-C ──→ Phase 1-D（MCP 工具依赖 HTTP 端点）

Phase 1-B ──→ Phase 2-C（session_wrapup 依赖 Manager.send）
Phase 2-A ──→ Phase 2-B（导出依赖目录结构）
Phase 2-B ──→ Phase 2-C（整理依赖 transcript）
Phase 2-A ──→ Phase 2-D（注入依赖 index.md 存在）
Phase 1-D ──→ Phase 2-E（remember 复用同一通信链路）

Phase 2-C ──→ Phase 3-A（全局睡眠依赖 session_wrapup 产出）
Phase 3-A ──→ Phase 3-B（处理依赖触发）
Phase 2-C ──→ Phase 3-C（自我修复在 query 中，但依赖 impressions 存在）

Phase 3-B ──→ Phase 4-A（性格线在 global_sleep 中分析）
Phase 2-D ──→ Phase 4-B（前端依赖新目录结构稳定）
```

### 建议节奏

| 阶段 | 预估 PR 数 | 备注 |
|------|-----------|------|
| Phase 0（A+B+C） | 1~2 | 可合并为一个 PR，改动小且安全 |
| Phase 1（A→B→C→D） | 2~3 | 1-A 单独一个，1-B+C+D 可合并 |
| Phase 2（A→B→C→D→E） | 2~3 | 2-A+B+C 一组，2-D+E 一组 |
| Phase 3（A→B→C） | 1~2 | 可合并为一个 PR |
| Phase 4（A+B+C） | 2~3 | 各自独立 |
