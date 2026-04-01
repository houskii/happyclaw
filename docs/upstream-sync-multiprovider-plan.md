# Upstream 同步与多 Provider 兼容方案（HappyClaw Fork）

本文目标：

1. 定期同步上游 `riba2534/happyclaw` 主干变更。
2. 将冲突收敛到“少量可预期文件”，尽量避免每次同步都手工大范围修复。
3. 保持（并逐步强化）本 Fork 的多 Provider 架构能力。

---

## 1. 约束与设计原则

### 1.1 约束

- 上游仓库不计划支持 Codex 版本（即不会主动兼容本 Fork 的运行时差异）。
- 本 Fork 已有核心差异：Memory Agent、消息路由、执行/会话隔离等，不可丢失。
- 目标是“持续可同步”，不是“一次性大迁移”。

### 1.2 原则

- **上游最小侵入**：尽量不在上游高频变更文件里堆积 Fork 逻辑。
- **差异外置**：将 Fork 差异放到插件层、adapter 层、overlay 层。
- **冲突可预测**：通过 `.gitattributes` + `git rerere` + 固定 patch 阶段，让冲突集中在固定文件。
- **能力兼容优先**：以“Provider 抽象稳定”为第一目标，单 Provider 特性可降级。

---

## 2. 分层同步策略（Branch + Overlay）

建议采用三层分支模型：

- `upstream-track`：纯跟踪上游，不放 Fork 业务逻辑。
- `fork-overlay`：只放本 Fork 差异（Provider 抽象、Codex runner 接口、消息路由扩展等）。
- `main`：发布分支，由自动流程将 `upstream-track` + `fork-overlay` 组装得到。

### 2.1 具体流程

1. `upstream-track` 定期 fast-forward 到上游 `main`。
2. 在 CI 中从 `upstream-track` 派生临时分支，按顺序 `cherry-pick`（或 `git replay`）`fork-overlay` 的补丁集。
3. 冲突只允许发生在“白名单文件”；超出白名单即失败并告警。
4. 通过回归测试后再快进到 `main`。

### 2.2 为什么有效

- 上游更新引入的差异不会直接与业务发布分支耦合。
- Fork patch 有固定顺序，可复用冲突解法（配合 `rerere`）。
- 可追溯“哪个 overlay patch 与上游冲突最频繁”。

---

## 3. 冲突最小化：文件分级与策略

先把仓库文件按“冲突风险”分为三级：

### A 类（高风险，尽量不改）

上游高频改动且核心主流程文件，例如：

- 主入口 `src/index.ts`（或等价启动编排文件）
- 调度主循环/消息主路由
- 关键 schema 定义（若上游频繁变）

策略：

- Fork 逻辑通过 `register*()` 扩展点注入，不直接改主流程。
- 必须改时，改成“单行 hook + 外置实现”。

### B 类（中风险，可控修改）

- Provider 配置读取层
- runtime-config / route handler
- IPC 组装层

策略：

- 保持函数签名尽量与上游一致。
- 采用“前后兼容参数 + 默认值”设计，减少上游合并冲突。

### C 类（低风险，Fork 自治）

- `container/agent-runner-core/**` 的插件实现
- `container/memory-agent/**`
- `docs/**`、脚本、测试

策略：

- 允许大胆演进，但要保证对 A/B 层 API 稳定。

---

## 4. Git 机制：让冲突“可复用”

### 4.1 启用 rerere

在 CI 和开发机统一开启：

```bash
git config rerere.enabled true
git config rerere.autoupdate true
```

作用：同类冲突二次出现时自动复用历史解法。

### 4.2 `.gitattributes` 合并策略

为极少数“本 Fork 必须保留”的文件设定合并策略（例如 `ours` / 自定义 merge driver），但只用于高度确定文件，避免掩盖上游关键更新。

建议仅用于：

- 纯 Fork 标识性文件（如 fork 专用脚本入口）
- 不应被上游覆盖的环境模板

### 4.3 冲突白名单门禁

在同步流水线增加检查：

- 允许冲突文件列表（如 `sync/conflict-allowlist.txt`）
- 若冲突文件超出白名单则流水线失败
- 输出“新增冲突文件 + 对应 patch”报告

---

## 5. 多 Provider 架构落地建议（防回归）

目标：上游即使是单 Provider，也能通过 adapter 平滑接入多 Provider。

### 5.1 稳定 Provider 抽象接口

建议统一为：

- `ProviderRegistry`：负责 Provider 生命周期与发现
- `ProviderAdapter`：屏蔽各 SDK 差异（chat / embeddings / tool-calls / image）
- `ModelCapabilityMatrix`：声明不同模型能力（tool、vision、json-mode、stream）

这样上游只需调用统一接口，不感知某个具体 SDK。

### 5.2 单向依赖

- 业务层 -> Provider 抽象层 -> 具体 Provider 插件
- 禁止反向依赖（具体 Provider 直接 import 业务内部类型）

收益：上游变更业务流程时，Provider 层不容易跟着冲突。

### 5.3 Provider 配置拆分

把配置拆成三层：

1. 全局默认（system）
2. 用户覆盖（user）
3. 会话覆盖（session）

并提供统一归并函数（pure function + schema 校验）。

收益：同步上游配置字段时，冲突主要集中在 schema 与 merge 函数，而不是散落全仓库。

### 5.4 降级策略标准化

定义统一 fallback：

- 不支持 tool-call -> 退化为纯文本 + 结构化提示
- 不支持 vision -> 明确返回能力不足事件
- 不支持 json-mode -> 使用 schema-guided text parser

这样可以降低“切换 Provider 后行为不一致”导致的回归。

---

## 6. 建议的同步节奏（可执行）

- **每周一次小同步**（建议固定在周三）。
- **每月一次大同步**（含依赖升级、SDK 协议变更扫描）。
- **紧急热修同步**：上游有安全修复时直接触发。

每次同步步骤：

1. 拉取上游并更新 `upstream-track`
2. 应用 `fork-overlay` patch 序列
3. 运行自动检查（类型、测试、关键 E2E）
4. 生成“冲突报告 + API 变更报告”
5. 人工 review 后合入 `main`

---

## 7. 最小化改造清单（建议先做）

1. 新增 `sync/` 目录：
   - `sync/conflict-allowlist.txt`
   - `sync/overlay-series.txt`（记录 patch 顺序）
   - `sync/run-sync.sh`（可本地/CI 复用）
2. 在 CI 增加 `sync-dry-run` job（仅演练不上主分支）。
3. 启用 `rerere` 并缓存 `.git/rr-cache`（CI 可选）。
4. Provider 层增加 capability matrix，与运行时路由解耦。

---

## 8. 风险与应对

- 风险：上游重构入口文件导致 A 类文件持续冲突。  
  应对：把入口改造为“最薄壳层”，业务差异进一步下沉插件。

- 风险：多 Provider 接口扩张过快导致抽象失真。  
  应对：用 capability-first 设计，拒绝在抽象层暴露 provider 私有参数。

- 风险：同步流程复杂化，团队不会用。  
  应对：所有步骤脚本化，保留 `make sync-upstream` 单命令入口。

---

## 9. 成功指标（建议量化）

- 同步 PR 平均冲突文件数 < 5。
- 非白名单冲突次数（月）= 0。
- 同步后 24h 内回滚次数 = 0。
- 新接入 Provider 从开发到可用 ≤ 2 天。

如果连续两个月未达标，说明分层和接口边界仍不够清晰，应优先继续“差异外置”重构。
