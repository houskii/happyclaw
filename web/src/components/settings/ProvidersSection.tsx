import { useState } from 'react';

import { ClaudeProviderSection } from './ClaudeProviderSection';
import { CodexProviderSection } from './CodexProviderSection';

export function ProvidersSection() {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="text-sm font-medium text-foreground">Provider 管理</div>
        <p className="mt-1 text-xs text-muted-foreground">
          这里管理系统级模型接入能力。Anthropic Provider 负责 Claude 体系，OpenAI / Codex Provider 负责 Codex CLI 与 API Key 模式。
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-success/30 bg-success-bg px-3 py-2 text-sm text-success">
          {notice}
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Anthropic Provider</h2>
          <p className="text-xs text-muted-foreground mt-1">
            管理 Claude OAuth、API Key、第三方 Anthropic 兼容网关与负载均衡。
          </p>
        </div>
        <ClaudeProviderSection setNotice={setNotice} setError={setError} />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">OpenAI / Codex Provider</h2>
          <p className="text-xs text-muted-foreground mt-1">
            管理 Codex CLI 登录态、OpenAI API Key Profiles，以及默认模型与自定义环境变量。
          </p>
        </div>
        <CodexProviderSection setNotice={setNotice} setError={setError} />
      </section>
    </div>
  );
}
