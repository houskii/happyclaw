# Provider 抽象改造计划（分阶段）

## Phase 1：抽象落地（无行为变更）

### 目标

引入接口与 registry，但不改变现有业务逻辑输出。

### 任务

- 新增 `src/provider-adapters/types.ts`
- 新增 `src/provider-adapters/registry.ts`
- 新增 `ClaudeAdapter`、`CodexAdapter` 骨架
- 保留现有 runtime-config 与路由

### 验收

- 类型检查通过
- 现有 API 行为无差异

## Phase 2：运行时接入（小步替换）

### 目标

让 runner / usage / 默认绑定消费统一 adapter。

### 任务

- runner：统一从 adapter 生成 env
- usage：通过 `fetchUsage` 调用（Codex 可先返回 not_supported）
- group 创建：统一调用 resolver

### 验收

- Claude/Codex 行为与当前一致
- 默认绑定逻辑不再散落

## Phase 3：配置 API 收敛（可扩展）

### 目标

引入通用 provider 配置 API，并保持旧接口兼容。

### 任务

- 新增 `/api/config/providers`、`/api/config/providers/:id`
- 旧 `/api/config/claude`、`/api/config/codex` 内部转发
- 前端设置页增加 Provider Registry 驱动模式

### 验收

- 新增第三方 provider 时无需修改 runner 主流程
- 配置读写链路统一

## 风险与回滚

### 风险

- 默认来源冲突（DB 默认与系统默认）
- 双路由兼容期配置漂移
- provider adapter 与旧逻辑不一致

### 回滚策略

- 保留旧路由与旧 runner 分支开关
- 通过 feature flag 切换 adapter 模式
- 保留配置文件原格式，延后 schema 迁移
