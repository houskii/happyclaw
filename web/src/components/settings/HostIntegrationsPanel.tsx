import { useMemo, useState } from 'react';
import { FolderSearch, RefreshCw, Save, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useHostIntegrationsStore } from '@/stores/host-integrations';
import type {
  HostIntegrationSource,
  HostIntegrationSourceStatus,
} from './types';
import { getErrorMessage } from './types';

interface HostIntegrationsPanelProps {
  isAdmin: boolean;
  target: 'skills' | 'mcp';
  onSynced?: () => Promise<void> | void;
}

function formatSyncTime(value: string | null): string {
  if (!value) return '未同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未同步';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function getStatusTone(status: HostIntegrationSourceStatus['status']): string {
  switch (status) {
    case 'ok':
      return 'bg-success-bg text-success border-success/20';
    case 'missing':
      return 'bg-warning/10 text-warning border-warning/20';
    case 'unreadable':
    case 'invalid':
      return 'bg-error/10 text-error border-error/20';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function cloneSources(sources: HostIntegrationSourceStatus[]): HostIntegrationSource[] {
  return sources.map(({ status: _status, message: _message, ...source }) => ({ ...source }));
}

export function HostIntegrationsPanel({ isAdmin, target, onSynced }: HostIntegrationsPanelProps) {
  const {
    sources,
    skills,
    mcp,
    saving,
    syncing,
    load,
    save,
    sync,
  } = useHostIntegrationsStore();

  const [draftSources, setDraftSources] = useState<HostIntegrationSource[] | null>(null);
  const [newPath, setNewPath] = useState('');

  const activeSources = draftSources ?? cloneSources(sources);
  const dirty = useMemo(() => {
    if (!draftSources) return false;
    return JSON.stringify(draftSources) !== JSON.stringify(cloneSources(sources));
  }, [draftSources, sources]);

  const targetSnapshot = target === 'skills' ? skills : mcp;

  const updateSource = (id: string, updater: (source: HostIntegrationSource) => HostIntegrationSource) => {
    setDraftSources((prev) => {
      const base = prev ?? cloneSources(sources);
      return base.map((source) => (source.id === id ? updater(source) : source));
    });
  };

  const resetDraft = () => {
    setDraftSources(null);
    setNewPath('');
  };

  const handleReload = async () => {
    await load();
    resetDraft();
  };

  const handleSave = async () => {
    try {
      await save(activeSources);
      setDraftSources(null);
      toast.success('宿主来源配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存宿主来源配置失败'));
    }
  };

  const handleSync = async () => {
    try {
      const result = await sync();
      await onSynced?.();
      const stats = target === 'skills' ? result.skills.stats : result.mcp.stats;
      toast.success(`同步完成：新增 ${stats.added}，更新 ${stats.updated}，删除 ${stats.deleted}，跳过 ${stats.skipped}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '同步宿主来源失败'));
    }
  };

  const handleAddSource = () => {
    const path = newPath.trim();
    if (!path) {
      toast.error('请输入来源路径');
      return;
    }
    setDraftSources((prev) => {
      const base = prev ?? cloneSources(sources);
      const nextId = `custom-${Date.now().toString(36)}`;
      return [
        ...base,
        {
          id: nextId,
          kind: 'custom',
          label: path,
          path,
          enabled: true,
          skillsEnabled: true,
          mcpEnabled: true,
        },
      ];
    });
    setNewPath('');
  };

  const removeSource = (id: string) => {
    setDraftSources((prev) => {
      const base = prev ?? cloneSources(sources);
      return base.filter((source) => source.id !== id);
    });
  };

  return (
    <Card className="border-border/60">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="text-sm font-semibold">宿主来源</div>
            <div className="mt-1 text-sm text-muted-foreground">
              统一管理 `{target === 'skills' ? 'Skills' : 'MCP Servers'}` 的宿主机来源。
              默认 provider 来源分别绑定 `~/.claude` 和 `~/.codex`，自定义来源可按项目级新增。
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
              最近同步：{formatSyncTime(targetSnapshot.lastSyncAt)} · 当前同步 {targetSnapshot.syncedCount}
            </div>
            <Button variant="outline" onClick={handleReload}>
              <RefreshCw size={16} />
              刷新来源
            </Button>
            {isAdmin && (
              <Button variant="outline" onClick={handleSync} disabled={syncing}>
                <FolderSearch size={16} className={syncing ? 'animate-pulse' : ''} />
                {syncing ? '同步中...' : '立即同步'}
              </Button>
            )}
            {isAdmin && dirty && (
              <Button onClick={handleSave} disabled={saving}>
                <Save size={16} />
                {saving ? '保存中...' : '保存配置'}
              </Button>
            )}
          </div>
        </div>

        {isAdmin && (
          <div className="rounded-lg border border-dashed border-border p-3">
            <div className="mb-2 text-sm font-medium">添加自定义来源</div>
            <div className="flex flex-col gap-2 md:flex-row">
              <Input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="例如 ~/.agent"
              />
              <Button onClick={handleAddSource}>
                <Plus size={16} />
                添加
              </Button>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              自定义来源不绑定 provider，后续按顺序覆盖默认来源中的同名 skill 或 MCP 配置。
            </div>
          </div>
        )}

        <div className="space-y-3">
          {sources.length === 0 ? (
            <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
              暂无宿主来源配置。
            </div>
          ) : (
            sources.map((statusSource) => {
              const source =
                activeSources.find((item) => item.id === statusSource.id) ??
                cloneSources([statusSource])[0];
              const targetEnabled = target === 'skills' ? source.skillsEnabled : source.mcpEnabled;
              const targetLabel = target === 'skills' ? 'Skills 接入' : 'MCP 接入';
              return (
                <div key={statusSource.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold">{source.label}</div>
                        <span className={`rounded-full border px-2 py-0.5 text-xs ${getStatusTone(statusSource.status)}`}>
                          {statusSource.status}
                        </span>
                        {source.kind === 'provider-default' && source.provider && (
                          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {source.provider === 'anthropic' ? 'Anthropic 默认来源' : 'OpenAI 默认来源'}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground">{source.path}</div>
                      {statusSource.message && (
                        <div className="text-xs text-muted-foreground">{statusSource.message}</div>
                      )}
                    </div>
                    {isAdmin && source.kind === 'custom' && (
                      <Button variant="ghost" size="sm" onClick={() => removeSource(source.id)}>
                        <Trash2 size={16} />
                        删除
                      </Button>
                    )}
                  </div>

                  <div className="mt-4 grid gap-4 md:grid-cols-3">
                    <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                      <Label htmlFor={`${source.id}-enabled`} className="text-sm">
                        整体启用
                      </Label>
                      <Switch
                        id={`${source.id}-enabled`}
                        checked={source.enabled}
                        disabled={!isAdmin}
                        onCheckedChange={(checked) =>
                          updateSource(source.id, (current) => ({ ...current, enabled: checked }))
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                      <Label htmlFor={`${source.id}-skills`} className="text-sm">
                        Skills 接入
                      </Label>
                      <Switch
                        id={`${source.id}-skills`}
                        checked={source.skillsEnabled}
                        disabled={!isAdmin || !source.enabled}
                        onCheckedChange={(checked) =>
                          updateSource(source.id, (current) => ({ ...current, skillsEnabled: checked }))
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                      <Label htmlFor={`${source.id}-mcp`} className="text-sm">
                        MCP 接入
                      </Label>
                      <Switch
                        id={`${source.id}-mcp`}
                        checked={source.mcpEnabled}
                        disabled={!isAdmin || !source.enabled}
                        onCheckedChange={(checked) =>
                          updateSource(source.id, (current) => ({ ...current, mcpEnabled: checked }))
                        }
                      />
                    </div>
                  </div>

                  <div className="mt-2 text-xs text-muted-foreground">
                    当前页面关注：{targetLabel} {targetEnabled ? '已启用' : '已禁用'}。
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
