# Codex App 中转断续流程设计

Date: 2026-04-14

## 背景

当前 HappyClaw 已经支持 Codex 作为 provider，但它与 Codex App 的协作关系仍然比较弱：

- HappyClaw 里的 Codex 执行通常发生在独立工作区
- Codex App 是用户的长期主线程入口
- 两边虽然都基于本地 Codex 状态，但不具备面向用户的“接手任务 -> 执行 -> 回写结果 -> 结束侧线”的明确流程

用户希望的不是让 HappyClaw 接管 Codex App 当前运行中的线程进程，而是让 HappyClaw 成为 Codex App 的一个中转执行分支：

- 从 Codex App 最近活跃线程中选择一条
- 将该线程上下文同步到 HappyClaw
- 在 HappyClaw 中开一个绑定工作区继续执行
- 将结果回写到同一条 Codex App 线程
- 回写成功后清理 HappyClaw 工作区

这是一种“主线程在 App，侧线在 HappyClaw”的 handoff 模型。

## 目标

- 为 HappyClaw 增加一套 `from app` / `to app` 中转断续流程
- `from app` 支持列出 Codex App 最近活跃线程，并按编号选择一条导入
- 默认导入模式为压缩 handoff，而不是整条线程直接入模
- 完整线程始终保留在工作区中，供后续检索和恢复
- 增加 `context_search` 能力，但仅在用户明确要求时触发
- `context_search` 只允许搜索当前工作区绑定的那条 App 线程
- `to app` 默认回写“结果摘要 + 关键产物”，不回灌完整 HappyClaw 过程
- `to app` 成功后自动清理该 HappyClaw 工作区；失败时保留现场
- 尽量不修改 Codex 本体，不依赖不稳定的内部参数或 patch 行为

## 非目标

- 不尝试让 HappyClaw 接管 Codex App 当前 in-memory 线程
- 不追求与 Codex App 完全一致的运行时语义
- 不做容器模式适配，第一阶段只支持 `host` 模式
- 不支持跨工作区或跨线程的全局上下文搜索
- 不默认让模型每轮自动检索历史 detail
- 不将 HappyClaw 完整对话过程同步回 Codex App

## 核心模型

本方案的核心是定义一个新的协作模型：

- Codex App thread：长期主线程
- HappyClaw workspace：临时中转执行分支
- Binding：二者之间的一对一绑定关系

因此这里的“同步上下文”不是“继承原线程的运行中状态”，而是：

1. 读取 Codex App 线程的可持久化历史
2. 重组为 HappyClaw 可消费的 handoff 上下文
3. 在 HappyClaw 工作区内继续执行
4. 再将结果回写给原 App 线程

从工程语义上，这不是“同一个线程继续跑”，而是“以同一主线程为锚点的侧线执行”。

## 方案概览

### 路线选择

推荐采用 `HappyClaw 外部适配层`：

- HappyClaw 自己读取本地 Codex 状态根中的线程列表与 transcript
- HappyClaw 自己维护工作区与 App thread 的绑定表
- HappyClaw 自己定义 handoff summary、上下文搜索和回写格式

不采用以下路线：

- 不直接修改系统 `codex` CLI 或 `@openai/codex-sdk`
- 不依赖当前漂移中的 `codex app-server` 非稳定参数
- 不尝试伪装 HappyClaw 成原生 Codex App 线程创建者

### 运行边界

第一阶段限定：

- 仅支持 `host` 模式
- 仅支持能访问宿主机同一 `CODEX_HOME` 的工作区
- 仅对明确由 `from app` 创建的工作区启用该流程

## 命令协议

### 1. `from app`

用途：

- 列出 Codex App 最近活跃线程
- 用户按编号选择一条
- 将该线程导入为新的 HappyClaw 中转工作区

交互流程：

1. 用户在 HappyClaw 发起 `from app`
2. HappyClaw 列出最近活跃线程列表
3. 用户输入编号
4. HappyClaw 读取该线程完整 transcript
5. 生成 handoff summary、完整快照、索引文件和绑定元数据
6. 新建工作区并进入绑定态

线程列表展示至少包含：

- 编号
- 线程标题
- 最近活跃时间
- 线程来源目录 / cwd 摘要
- 最近一条用户消息摘要

### 2. `to app`

用途：

- 将当前绑定工作区的结果回写到原 App 线程

默认回写内容：

- 结果摘要
- 关键产物路径
- 必要的下一步建议

成功后：

- 标记工作区状态为 `synced`
- 清理工作区

失败时：

- 标记状态为 `failed`
- 保留工作区和绑定数据，便于重试

### 3. `context_search`

定位：

- 这是模型可调用工具，不要求用户手动输入底层搜索语法

触发约束：

- 只在用户明确表达“去翻一下 / 找一下之前上下文”时允许触发
- 只搜索当前工作区绑定的那条 App 线程
- 不跨线程扩散

返回内容：

- 命中片段列表
- 命中原因
- 时间位置
- 可展开的片段 id

### 4. `context_open`

用途：

- 展开 `context_search` 命中的原始片段

### 5. `context_rehydrate`

用途：

- 将命中的 detail 临时补回下一轮模型上下文

这是 detail 恢复的关键能力。默认压缩上下文不意味着 detail 丢失，而是默认不展开；需要时通过 `context_rehydrate` 重新入模。

## 上下文模型

### 默认上下文

`from app` 默认不把完整线程直接塞进首轮 prompt，而是只导入压缩 handoff。

handeoff summary 至少包含：

- 当前任务目标
- 已确认约束
- 关键决策
- 未完成事项
- 最近关键轮次
- 来源线程标识

### 完整上下文

完整线程会完整保存在工作区，但默认不直接入模。

这意味着：

- 数据层：完整保真
- 入模层：默认压缩

这是一个“可逆压缩”设计，而不是“丢弃式压缩”设计。

## 工作区落盘结构

每个由 `from app` 生成的工作区，建议至少落这些文件：

- `app_binding.json`
- `app_context_summary.md`
- `app_thread_transcript.jsonl`
- `app_context_index.json`

### `app_binding.json`

记录绑定关系和同步状态：

```json
{
  "sourceThreadId": "thread-id",
  "sourceThreadTitle": "title",
  "sourceThreadCwd": "/path",
  "importedAt": "2026-04-14T12:34:56.000Z",
  "importMode": "handoff",
  "status": "active"
}
```

状态取值：

- `active`
- `syncing`
- `synced`
- `failed`

### `app_context_summary.md`

这是默认上下文来源，也是用户快速浏览 handoff 内容的主要文件。

### `app_thread_transcript.jsonl`

保存完整线程快照，供：

- `context_search`
- `context_open`
- `context_rehydrate`

### `app_context_index.json`

索引建议包含：

- chunk id
- 时间范围
- 说话人
- 摘要
- 决策标签
- 命令 / 文件 / 链接抽取

## 状态机

### 生命周期

1. `idle`
   无绑定工作区

2. `listing`
   正在列最近活跃线程

3. `selecting`
   等待用户按编号选择

4. `importing`
   正在拉取 thread transcript 并生成工作区文件

5. `active`
   工作区已绑定，可继续执行

6. `syncing`
   正在执行 `to app`

7. `synced`
   回写成功，等待清理完成

8. `failed`
   导入或回写失败，保留现场

## `from app` 数据流

### 步骤

1. 从本地 Codex 状态读取最近活跃线程列表
2. 返回列表给用户
3. 接收编号选择
4. 读取该线程对应的 transcript 和 thread metadata
5. 生成压缩 handoff summary
6. 生成 transcript 快照和索引
7. 创建新的 HappyClaw 工作区
8. 写入绑定文件
9. 将 summary 接入工作区默认上下文

### 可见性

该工作区在 HappyClaw 里是一个显式新工作区，但在语义上它不是新的主线程，而是原 App 线程的执行分支。

## `to app` 数据流

### 步骤

1. 读取 `app_binding.json`
2. 校验绑定 thread id 存在
3. 组装结果摘要和关键产物
4. 回写到同一条 App 线程
5. 成功后标记 `synced`
6. 清理工作区

### 回写格式

推荐统一成结构化摘要模板：

- 本次目标
- 本次处理结果
- 关键产物
- 后续建议

不回写完整 HappyClaw 推理过程或工作区全文 transcript。

## Token / Cache 影响

### 结论

默认压缩导入是更稳的默认策略。

原因：

- `from app` 如果直接整条线程入模，首轮输入过大，token 成本高
- HappyClaw 的 system prompt、工具集合、cwd 与 App 不同，首轮很难继承 App 的 cache 前缀
- 完整线程虽然更保真，但不适合作为默认首轮上下文

因此推荐：

- 完整线程落盘
- 默认只把 handoff summary 入模
- 需要 detail 时才显式 `context_search` / `context_rehydrate`

### 对 cache 的影响

- `from app` 默认压缩，有利于控制首轮 token
- 完整 transcript 不直接入模，避免大量无效冷前缀
- `context_search` 只在用户明确要求时触发，降低误召回和 cache 污染
- `to app` 回写到同一线程，有利于 App 侧保留长期连续性
- HappyClaw 工作区在 `to app` 成功后清理，意味着主动放弃 HappyClaw 自己的后续 cache 连续性；这符合“App 为主线程，HappyClaw 为 worker”模型

## 风险与兼容性

### 低风险点

- 不修改 Codex 本体
- 不修改 Codex SDK 源码
- 不依赖 patch `node_modules`
- 对 `make update-sdk` 友好

### 主要兼容风险

- 本地 Codex 状态文件结构未来可能变化
- recent thread 列表提取策略未来可能需要调整
- transcript 元数据字段可能变化

### 缓解策略

- 加 schema guard
- 对最近线程读取逻辑做版本兼容层
- 对工作区绑定和 transcript 导入做显式校验
- 所有异常都降级为“无法导入 / 无法回写”，不影响 HappyClaw 普通工作区

## 错误处理

### `from app`

- 线程列表为空：提示无可导入线程
- 线程选择无效：提示重新选择
- transcript 缺失：导入失败，不创建工作区
- 索引生成失败：导入失败，不创建工作区

### `context_search`

- 无绑定：直接拒绝
- 无命中：返回未找到
- transcript 文件损坏：返回错误，不自动扩大搜索范围

### `to app`

- 无绑定：拒绝执行
- 回写失败：保留工作区，状态置 `failed`
- 清理失败：提示清理失败，但保持 `synced`

## 测试策略

### 核心流程

- `from app` 能正确列最近线程
- 用户可按编号选择线程
- 工作区成功生成并绑定
- 默认上下文仅包含 handoff summary
- 完整 transcript 已落盘

### 上下文恢复

- 用户明确要求时模型可以调用 `context_search`
- `context_search` 只搜索绑定线程
- `context_open` 能展开原始片段
- `context_rehydrate` 能将 detail 补回下一轮

### 回写与清理

- `to app` 回写到同一条线程
- 回写成功后清理工作区
- 回写失败时保留现场

### 兼容回归

- 升级 `@openai/codex-sdk` 后最近线程读取仍可工作
- 非 `from app` 创建的工作区不受影响
- 普通 HappyClaw 工作流不受影响

## 实施建议

建议分两阶段：

### Phase 1

- `from app`
- `to app`
- `app_binding.json`
- `app_context_summary.md`
- `app_thread_transcript.jsonl`

### Phase 2

- `app_context_index.json`
- `context_search`
- `context_open`
- `context_rehydrate`

这样可以先把中转断续主链路做通，再补 detail 恢复能力。

## 总结

本方案的本质不是让 HappyClaw 接管 Codex App 原线程，而是：

- 从 App 主线程做 handoff
- 在 HappyClaw 开一个绑定工作区执行
- 再把结果回写回原主线程

这是一套“主线程在 App，侧线在 HappyClaw”的中转断续流程。

它的优点是：

- break risk 低
- 不依赖不稳定的内部 API
- 默认 token 成本更稳
- detail 可逆恢复

建议按此方案进入实现计划阶段。
