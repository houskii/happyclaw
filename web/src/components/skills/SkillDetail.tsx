import { useState, useEffect, useMemo } from 'react';
import { File, Folder, Loader2, Lock, Trash2, Package } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useSkillsStore,
  type SkillDetail as SkillDetailType,
  type SkillVariantDetail,
} from '../../stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import type { HostIntegrationConflictItem } from '../../types/host-integrations';

interface SkillDetailProps {
  skillId: string | null;
  onDeleted?: () => void;
  conflict?: HostIntegrationConflictItem | null;
}

export function SkillDetail({ skillId, onDeleted, conflict }: SkillDetailProps) {
  const [detail, setDetail] = useState<SkillDetailType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [variant, setVariant] = useState<SkillVariantDetail | null>(null);
  const [variantLoading, setVariantLoading] = useState(false);
  const getSkillDetail = useSkillsStore((state) => state.getSkillDetail);
  const getSkillVariant = useSkillsStore((state) => state.getSkillVariant);
  const deleteSkill = useSkillsStore((state) => state.deleteSkill);
  const updateConflict = useSkillsStore((state) => state.updateConflict);

  const previewSourceId = useMemo(() => {
    if (!conflict) return null;
    if (conflict.mode === 'pinned' && conflict.pinnedSourceId) {
      return conflict.pinnedSourceId;
    }
    return conflict.effectiveSourceId;
  }, [conflict]);

  useEffect(() => {
    if (!skillId) {
      setDetail(null);
      setError(null);
      return;
    }

    const loadDetail = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getSkillDetail(skillId);
        setDetail(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
        setDetail(null);
      } finally {
        setLoading(false);
      }
    };

    loadDetail();
  }, [skillId, getSkillDetail, conflict?.effectiveSourceId]);

  useEffect(() => {
    if (!skillId || !previewSourceId || !conflict) {
      setVariant(null);
      setVariantLoading(false);
      return;
    }

    let disposed = false;
    const loadVariant = async () => {
      setVariantLoading(true);
      try {
        const next = await getSkillVariant(skillId, previewSourceId);
        if (!disposed) {
          setVariant(next);
        }
      } catch {
        if (!disposed) {
          setVariant(null);
        }
      } finally {
        if (!disposed) {
          setVariantLoading(false);
        }
      }
    };

    void loadVariant();
    return () => {
      disposed = true;
    };
  }, [skillId, previewSourceId, conflict, getSkillVariant]);

  if (!skillId) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-muted-foreground text-center">选择一个技能查看详情</p>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="animate-spin text-primary" size={32} />
        </CardContent>
      </Card>
    );
  }

  if (error || !detail) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-error text-center">{error || '加载失败'}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="p-6 border-b border-border">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-foreground">{detail.name}</h2>
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  detail.source === 'user'
                    ? 'bg-brand-100 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {detail.source === 'user' ? '用户级' : '项目级'}
              </span>
              {detail.syncedFromHost && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-warning-bg text-warning">
                  已同步
                </span>
              )}
              {detail.userInvocable && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                  可调用
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{detail.description}</p>
          </div>

          {detail.source === 'project' ? (
            <div className="flex items-center gap-2">
              <Lock size={16} className="text-muted-foreground" />
              <div
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  detail.enabled ? 'bg-primary' : 'bg-muted-foreground/40'
                } opacity-50`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white dark:bg-foreground transition-transform ${
                    detail.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                disabled={deleting}
                onClick={async () => {
                  if (!confirm(`确认删除技能「${detail.name}」？`)) return;
                  setDeleting(true);
                  try {
                    await deleteSkill(detail.id);
                    onDeleted?.();
                  } catch {
                    // error is handled by the store
                  } finally {
                    setDeleting(false);
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-error hover:bg-error-bg transition-colors disabled:opacity-50"
              >
                <Trash2 size={16} />
                {deleting ? '删除中...' : '删除'}
              </button>
            </div>
          )}
        </div>

        {conflict && (
          <div className="mb-4 rounded-lg border border-warning/30 bg-warning-bg/30 p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm font-medium text-foreground">来源版本</div>
                <div className="text-xs text-muted-foreground">
                  当前生效：
                  <span className="ml-1 font-medium text-foreground">
                    {conflict.effectiveSourceLabel ?? '未选择'}
                  </span>
                  {conflict.effectiveSourcePath && (
                    <span className="ml-1 font-mono">{conflict.effectiveSourcePath}</span>
                  )}
                </div>
                {conflict.warning && (
                  <div className="text-xs text-warning">{conflict.warning}</div>
                )}
              </div>
              <div className="w-full lg:w-72">
                <Select
                  value={
                    conflict.mode === 'pinned' && conflict.pinnedSourceId
                      ? conflict.pinnedSourceId
                      : 'auto'
                  }
                  onValueChange={(value) => {
                    void updateConflict(
                      conflict.itemId,
                      value === 'auto' ? 'auto' : 'pinned',
                      value === 'auto' ? undefined : value,
                    );
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自动（按来源优先级）</SelectItem>
                    {conflict.candidates.map((candidate) => (
                      <SelectItem key={candidate.sourceId} value={candidate.sourceId}>
                        {candidate.sourceLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        {conflict && (
          <div className="mb-4 rounded-lg border border-border/60 bg-background/70 p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">当前来源内容预览</div>
                {variant && (
                  <div className="text-xs text-muted-foreground">
                    {variant.sourceLabel}
                    <span className="ml-1 font-mono">{variant.sourcePath}</span>
                  </div>
                )}
              </div>
              {variantLoading && <Loader2 className="animate-spin text-primary" size={16} />}
            </div>
            {variant ? (
              <>
                {variant.description && (
                  <div className="mb-3 text-sm text-muted-foreground">{variant.description}</div>
                )}
                <div className="max-h-72 overflow-auto rounded-md border border-border bg-background p-3">
                  <MarkdownRenderer content={variant.content} variant="docs" />
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">
                {variantLoading ? '正在加载来源内容…' : '当前来源没有可预览的内容'}
              </div>
            )}
          </div>
        )}

        {/* 元信息区域 */}
        <div className="space-y-2 text-sm">
          {detail.packageName && (
            <div className="flex items-center gap-1.5">
              <Package size={14} className="text-muted-foreground" />
              <span className="text-muted-foreground">来源：</span>
              <span className="text-foreground font-mono text-xs">{detail.packageName}</span>
            </div>
          )}
          {detail.installedAt && (
            <div>
              <span className="text-muted-foreground">安装时间：</span>
              <span className="text-foreground ml-1">
                {new Date(detail.installedAt).toLocaleString('zh-CN')}
              </span>
            </div>
          )}
          {detail.allowedTools && detail.allowedTools.length > 0 && (
            <div>
              <span className="text-muted-foreground">允许工具：</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {detail.allowedTools.map((tool: string) => (
                  <span
                    key={tool}
                    className="px-2 py-0.5 bg-muted text-foreground rounded text-xs"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
          {detail.argumentHint && (
            <div>
              <span className="text-muted-foreground">参数提示：</span>
              <span className="text-foreground ml-2">{detail.argumentHint}</span>
            </div>
          )}
        </div>
      </div>

      {/* SKILL.md 内容 */}
      <div className="p-6 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground mb-3">技能说明</h3>
        <div className="max-w-none">
          <MarkdownRenderer content={detail.content} variant="docs" />
        </div>
      </div>

      {/* 文件列表 */}
      {detail.files && detail.files.length > 0 && (
        <div className="p-6 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground mb-3">文件列表</h3>
          <div className="space-y-1">
            {detail.files.map((file) => (
              <div
                key={file.name}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                {file.type === 'directory' ? (
                  <Folder size={16} className="text-muted-foreground" />
                ) : (
                  <File size={16} className="text-muted-foreground" />
                )}
                <span>{file.name}</span>
                {file.type === 'file' && (
                  <span className="text-xs text-muted-foreground">({file.size} B)</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 底部操作区 */}
      <div className="p-6 bg-muted">
        <p className="text-sm text-muted-foreground">
          {detail.source === 'user'
            ? detail.syncedFromHost
              ? '从宿主机同步，可启停和删除。重新同步时会恢复'
              : '用户级技能可启用/禁用或删除，也可在对话中让 AI 安装或卸载技能'
            : '项目级技能为只读，不可修改或删除'}
        </p>
      </div>
    </Card>
  );
}
