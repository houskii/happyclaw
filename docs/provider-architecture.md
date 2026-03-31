# Provider 抽象架构设计（Claude / Codex / Future SDK）

## 目标

将当前系统中与 Claude/Codex 相关的默认绑定、运行时注入、用量查询、SDK 基础地址等能力统一抽象为可扩展的 Provider 接口层，避免继续在业务路径中散落 `if (provider === '...')`。

## 分层架构

### 1) Provider 定义层（抽象）

定义统一接口，不含具体实现：

- `ProviderAdapter`：单个 provider 的能力实现
- `ProviderRegistry`：provider 注册与查询
- `ProviderResolvedConfig`：合并系统默认 / provider 配置 / group 覆盖后的运行时配置
- `ProviderCapabilities`：能力声明（chat、usage、oauth、api_key、cli_auth、custom_env）

### 2) Provider 配置层（实例）

每个 provider 按统一模型管理：

- 元信息：`id`、`label`、`capabilities`
- 认证：`mode` + secret refs
- 端点：`apiBaseUrl`、`usageApiUrl`
- 模型：`defaultModel`
- 环境：`customEnv`
- profiles：`profiles[] + activeProfileId`

### 3) Provider 消费层（运行时）

业务方统一调用 registry，不直接感知 Claude/Codex 差异：

- 工作区默认绑定
- runner 环境变量注入
- usage 路由调用
- 设置页 provider 列表与动态 schema

## 关键接口草案

```ts
export type ProviderId = 'claude' | 'codex' | string;

export interface ProviderCapabilities {
  chat: boolean;
  usage: boolean;
  oauth: boolean;
  apiKey: boolean;
  cliAuth: boolean;
  customEnv: boolean;
}

export interface ProviderResolvedConfig {
  providerId: ProviderId;
  activeProfileId?: string;
  model?: string;
  auth: {
    mode: 'oauth' | 'api_key' | 'cli' | 'none';
    tokenRef?: string;
  };
  endpoints: {
    apiBaseUrl?: string;
    usageApiUrl?: string;
  };
  customEnv: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  resolve(group: RegisteredGroup): ProviderResolvedConfig;
  buildRuntimeEnv(resolved: ProviderResolvedConfig, group: RegisteredGroup): Record<string, string>;
  fetchUsage?(ctx: { userId: string; folder: string }): Promise<unknown>;
}
```

## 迁移策略（不破坏线上）

1. 先引入抽象接口与 registry（不替换现有逻辑）。
2. Claude/Codex 写 adapter，内部复用当前 runtime-config。
3. runner / usage / group-create 逐步改为调用 adapter。
4. 路由层逐步从 `/config/claude|codex` 收敛到 `/config/providers/:id`。
5. 完成后移除散落的 provider 分支。

## 兼容策略

- 保持 `registered_groups.llm_provider` 字段不变，逐步过渡。
- 保持现有 `/api/config/claude`、`/api/config/codex` API 可用。
- provider 抽象落地后，旧路由内部调用 registry。

## 非目标

- 本阶段不做 DB 大迁移。
- 本阶段不改动已有凭据加密方案。
- 本阶段不改变工作区隔离与 IPC 机制。
