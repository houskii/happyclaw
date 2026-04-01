# Fork Overlay Capability Spec

## 目标

Fork Overlay 用于承载不准备直接贡献回 upstream 的增强能力，并保证这些能力在后续 upstream 同步中不会发生未记录的偏移。

## 核心能力

### 1. 双 Provider 执行链路

- 同时支持 Claude 与 Codex 两条执行链路。
- Claude 与 Codex 共享统一的 runner 抽象和工作区默认绑定入口。
- Provider 差异应优先收敛在 provider 边界内，而不是散落在主流程文件中。

### 2. Provider 配置与默认绑定

- 系统存在统一的 provider 默认绑定入口。
- Claude 与 Codex 均可通过各自配置页或统一 provider 概览接口管理。
- 配置聚合层需要维持对现有接口的兼容，不因重构造成外部行为变化。

### 3. 显式 Overlay 治理

- fork 的增强能力需要有独立账本和版本变化记录。
- 后续同步必须基于 overlay 能力定义进行校验，而不是仅依据代码编译结果判断。

## 行为边界

### Claude 专属

- Claude SDK 会话语义
- Claude 专属事件处理和工具调用细节
- Claude 凭据、配置、使用量接口的私有实现

### Codex 专属

- Codex runner / session / archive 集成
- Codex API Key 或 CLI 登录态接入
- Codex 专属设置项与运行时桥接

### 共享 Provider 语义

- 工作区默认 provider 绑定
- 通用 provider 概览与调度入口
- 通用 runner 抽象
- Claude / Codex 之间共享的能力语义名称

## 稳定承诺

以下能力属于当前 overlay 的稳定承诺，后续 upstream 同步不得无记录改变：

- 双 provider 架构仍然存在；
- Claude 与 Codex 都能通过统一入口被调度；
- 配置层仍然能表达系统默认 provider 绑定；
- overlay 的能力变化和同步结论都有文档记录。

## 一致性要求

### Claude 一致性

upstream 新增或调整的 Claude 场景，需要先判断其属于 Claude 专属变化还是共享 provider 语义变化。前者应保留在 Claude 边界内；后者才允许进入共享抽象层。

### Overlay 一致性

每次同步后，都必须重新核对本文件中的稳定承诺是否仍然成立。如果存在变化，必须同步更新 `change-log.md` 并写入一份兼容性报告。
