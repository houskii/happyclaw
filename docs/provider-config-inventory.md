# Provider 配置项盘点与统一映射

> 目标：梳理当前框架中 Claude/Codex 的全部关键配置，并映射到统一 ProviderConfig。

## A. 现有配置清单

### A1. 系统级默认（SystemSettings）

- `defaultLlmProvider`
- `defaultClaudeModel`
- `defaultCodexModel`
- `claudeUsageApiUrl` / `codexUsageApiUrl`
- `claudeSdkBaseUrl` / `codexSdkBaseUrl`

### A2. Claude 专属

- 官方配置：`anthropicApiKey` / `claudeCodeOauthToken` / `claudeOAuthCredentials`
- 第三方配置：`anthropicBaseUrl` + `anthropicAuthToken`
- 模型：`happyclawModel`
- profile：`profiles[] + activeProfileId`
- 环境：`customEnv`

### A3. Codex 专属

- `mode`: `cli | api_key`
- profile：`openaiApiKey` / `baseUrl` / `defaultModel` / `customEnv`
- 本地 CLI 探测：`~/.codex/auth.json`

### A4. 工作区覆盖

- `llm_provider`
- `model`
- `thinking_effort`

## B. 统一映射表

| 统一字段 | Claude 来源 | Codex 来源 | 备注 |
|---|---|---|---|
| `providerId` | `claude` | `codex` | 从 `llm_provider` 或系统默认解析 |
| `auth.mode` | `oauth/api_key` | `cli/api_key` | 统一四态：`oauth/api_key/cli/none` |
| `auth.tokenRef` | Claude secrets | Codex profile secret | 仅保存引用，不直接下发明文 |
| `endpoints.apiBaseUrl` | `anthropicBaseUrl` | `baseUrl` | 可被系统级 SDK Base URL 覆盖 |
| `endpoints.usageApiUrl` | `claudeUsageApiUrl` | `codexUsageApiUrl` | 用量接口抽象 |
| `model` | `group.model > defaultClaudeModel > happyclawModel` | `group.model > profile.defaultModel > defaultCodexModel` | 统一优先级 |
| `customEnv` | active Claude profile `customEnv` | active Codex profile `customEnv` | 保持白名单过滤 |
| `capabilities.usage` | true | false(初期) | Codex 后续可补 |

## C. 默认解析优先级（建议）

1. 工作区显式值（group）
2. 活跃 profile
3. 系统默认（SystemSettings）
4. provider 内置默认

## D. 需要收敛的分散点

- group 创建入口（Web/IM /new/IM auto-create）
- runner 的 env 注入
- usage 路由 provider 分支
- 设置页 provider 配置入口
