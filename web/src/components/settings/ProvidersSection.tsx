import { useState } from 'react';

import { useAuthStore } from '@/stores/auth';
import { ClaudeProviderSection } from './ClaudeProviderSection';
import { CodexProviderSection } from './CodexProviderSection';
import { HostIntegrationsPanel } from './HostIntegrationsPanel';

export function ProvidersSection() {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="text-sm font-medium text-foreground">Provider 管理</div>
        <p className="mt-1 text-xs text-muted-foreground">
          这里管理系统级模型接入能力。Anthropic 通道用于 Anthropic 生态接入，OpenAI 通道用于 OpenAI API 与 CLI 模式。
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
          <h2 className="text-base font-semibold text-foreground">Anthropic 通道</h2>
          <p className="text-xs text-muted-foreground mt-1">
            管理 Anthropic 登录态、API Key、第三方 Anthropic 兼容网关与负载均衡。
          </p>
        </div>
        <ClaudeProviderSection setNotice={setNotice} setError={setError} />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">OpenAI 通道</h2>
          <p className="text-xs text-muted-foreground mt-1">
            管理 CLI 登录态、OpenAI API Key profiles，以及默认模型与自定义环境变量。
          </p>
        </div>
        <CodexProviderSection setNotice={setNotice} setError={setError} />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">宿主来源接入</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            管理项目级宿主机来源路径，以及它们是否向 Skills 和 MCP Servers 暴露内容。
          </p>
        </div>
        <HostIntegrationsPanel isAdmin={isAdmin} />
      </section>
    </div>
  );
}
