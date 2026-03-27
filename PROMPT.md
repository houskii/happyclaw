# Ralph Loop: Multi-Provider Agent Runner 实现

> 设计文档: `docs/design-codex-runner.md`（完整接口定义、代码示例、验证矩阵）
> 当前分支: `refactor/agent-harness-cleanup`

## 你的任务

按照设计文档 `docs/design-codex-runner.md` 的 Phase 0 → Phase 1 → Phase 2 顺序，逐步实现 multi-provider agent runner 架构。每个 step 完成后 commit（中文 commit message），然后继续下一个 step。

**关键原则**：
- 每个 step 必须通过 `make typecheck` 和 `make build`（在项目根目录运行）
- Phase 0 是纯重构，Claude 现有功能必须完全保留
- Phase 1 是新增 Codex provider
- Phase 2 是宿主机集成
- Git commit message 使用简体中文，格式：`类型: 简要描述（Phase X Step Y）`
- 不要跳步，按顺序来
- 严格遵循设计文档的接口定义和类型签名

## 进度检查清单

**每次迭代开始时**，先检查哪些步骤已完成（检查文件是否存在、git log），然后从下一个未完成的步骤开始。

### Phase 0: 解耦基础设施（不加 Codex，纯重构）

- [ ] **Step 0.1**: `session-state.ts` / `ipc-handler.ts` 中 `PermissionMode` → `string`
  - 验证: `make typecheck`

- [ ] **Step 0.2**: `types.ts` 中移除 `SDKUserMessage` → 移入 `claude-session.ts`
  - 验证: `make typecheck`

- [ ] **Step 0.3**: 创建 `runner-interface.ts`（AgentRunner + NormalizedMessage + ActivityReport + QueryConfig + QueryResult + IpcCapabilities 类型）
  - 内容严格按设计文档 §3.1 的接口定义
  - 验证: `make typecheck`

- [ ] **Step 0.4**: 增强 core prompt 系统（最复杂，分 sub-step）
  - **0.4a**: 扩展 `agent-runner-core/src/plugin.ts` 的 PluginContext：加 `recentImChannels?: Set<string>`、`contextSummary?: string`、`providerInfo?: string`
  - **0.4b**: 将 `context-builder.ts` 的静态常量搬入 `agent-runner-core/src/prompt-builder.ts`：INTERACTION_GUIDELINES、OUTPUT_GUIDELINES、WEB_FETCH_GUIDELINES、BACKGROUND_TASK_GUIDELINES + IM routing 段 + buildChannelRoutingReminder
  - **0.4c**: 在 core 的 `prompt-builder.ts` 重写 `buildAppendPrompt(ctx, plugins)` 组装全部 8 段
  - **0.4d**: 增强 `plugins/memory.ts` 的 `getSystemPromptSection()`：合并 context-builder 的详版记忆段（home/non-home 区分）
  - **0.4e**: `context.ts` 中 ContextManager 新增 `buildAppendPrompt()`、`updateDynamicContext()`、`writeFullPromptToFile()`
  - **0.4f**: 确保新旧 prompt 输出一致（可内联对比或写临时脚本）
  - 验证: `make typecheck` + prompt 输出一致性

- [ ] **Step 0.5**: agent-runner 切换到 core prompt
  - `query-runner.ts` 的 `runQuery()` 改用 `ctxMgr.buildAppendPrompt()` 替代旧的 `buildSystemPromptAppend()`
  - 删除 `context-builder.ts`（`buildChannelRoutingReminder` 已在 core）
  - 验证: `make typecheck` + `make build`

- [ ] **Step 0.6**: 创建 `providers/claude/` 目录，移入 Claude 相关文件
  - `stream-processor.ts` → `providers/claude/claude-stream-processor.ts`
  - `claude-session.ts` → `providers/claude/claude-session.ts`
  - `mcp-adapter.ts` → `providers/claude/claude-mcp-adapter.ts`
  - `transcript-archive.ts` + `safety-lite.ts` → `providers/claude/claude-hooks.ts`（合并）
  - `agent-definitions.ts` → `providers/claude/claude-agent-defs.ts`
  - 新建 `providers/claude/claude-config.ts`（DEFAULT_ALLOWED_TOOLS + 模型别名，从 index.ts/query-runner.ts 提取）
  - 更新所有 import 路径
  - 验证: `make typecheck` + `make build`

- [ ] **Step 0.7**: 实现 ClaudeRunner（封装现有逻辑，实现 AgentRunner 接口）
  - 创建 `providers/claude/claude-runner.ts`
  - ClaudeRunner.runQuery() 替代 processMessages()
  - getActivityReport() 封装 stream-processor 状态查询
  - 验证: `make typecheck` + `make build`

- [ ] **Step 0.8**: 提取 `query-loop.ts`（含活性看门狗 + unified IPC poller）
  - 从 index.ts 提取通用循环逻辑到 `query-loop.ts`
  - 重写 `index.ts` 为薄入口（readStdin → selectProvider → startLoop）
  - 验证: `make typecheck` + `make build`

### Phase 1: Codex Provider 核心能力

- [ ] **Step 1.1**: 安装 `@openai/codex-sdk` + `@modelcontextprotocol/sdk` 到 agent-runner
- [ ] **Step 1.2**: 实现 `providers/codex/codex-mcp-server.ts`（stdio MCP bridge，独立入口点）
- [ ] **Step 1.3**: 实现 `providers/codex/codex-session.ts`（SDK Thread 生命周期）
- [ ] **Step 1.4**: 实现 `providers/codex/codex-event-adapter.ts`（ThreadEvent → StreamEvent 映射）
- [ ] **Step 1.5**: 实现 `providers/codex/codex-image-utils.ts`（base64 → 临时文件）
- [ ] **Step 1.6**: 实现 `providers/codex/codex-runner.ts`（实现 AgentRunner 接口）
- [ ] **Step 1.7**: `index.ts` 加 provider 选择分支（读 `HAPPYCLAW_LLM_PROVIDER` 环境变量）

### Phase 2: 归档 + 宿主机集成

- [ ] **Step 2.1**: 实现 `providers/codex/codex-archive.ts`（token 阈值归档）
- [ ] **Step 2.2**: 修改 `src/container-runner.ts`（Codex 环境变量注入、provider 选择）
- [ ] **Step 2.3**: 实现 Codex API key 管理（runtime-config + 加密存储 + routes/config.ts）

## 完成信号

当 Phase 0 + Phase 1 + Phase 2 全部完成，且 `make typecheck` 和 `make build` 都通过时，输出：

<promise>CODEX RUNNER COMPLETE</promise>

## 重要参考

- 设计文档的完整接口定义在 §3（AgentRunner 接口）、§4（Prompt）、§5（Query Loop）、§6（Provider 实现）
- `container/agent-runner-core/src/` 是共享库，零 SDK 引用
- `container/agent-runner/src/` 是执行引擎
- 当前 agent-runner 有 16 个文件，agent-runner-core 有 13 个文件
- `shared/stream-event.ts` 是 StreamEvent 类型的单一真相源
- 修改 StreamEvent 后要 `make sync-types`
