import { useEffect, useState, useMemo } from 'react';
import { RefreshCw, Puzzle } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useSkillsStore } from '../stores/skills';
import { useHostIntegrationsStore } from '../stores/host-integrations';
import { useAuthStore } from '../stores/auth';
import { SkillCard } from '../components/skills/SkillCard';
import { SkillDetail } from '../components/skills/SkillDetail';
import { HostIntegrationsPanel } from '../components/settings/HostIntegrationsPanel';

export function SkillsPage() {
  const {
    skills,
    loading,
    error,
    loadSkills,
  } = useSkillsStore();
  const loadHostIntegrations = useHostIntegrationsStore((s) => s.load);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadSkills();
    loadHostIntegrations();
  }, [loadSkills, loadHostIntegrations]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }, [skills, searchQuery]);

  const manualUserSkills = filtered.filter((s) => s.source === 'user' && !s.syncedFromHost);
  const syncedUserSkills = filtered.filter((s) => s.source === 'user' && s.syncedFromHost);
  const projectSkills = filtered.filter((s) => s.source === 'project');

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="技能(Skill)管理"
            subtitle={`用户级 ${manualUserSkills.length + syncedUserSkills.length}${syncedUserSkills.length > 0 ? `（含同步 ${syncedUserSkills.length}）` : ''} · 项目级 ${projectSkills.length} · 启用 ${enabledCount}`}
            actions={
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={loadSkills} disabled={loading}>
                  <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                  刷新
                </Button>
              </div>
            }
          />
        </div>
        {/* Content */}
        <div className="space-y-4 p-4">
          <HostIntegrationsPanel
            isAdmin={isAdmin}
            target="skills"
            onSynced={loadSkills}
          />

          <div className="flex gap-6">
          {/* 左侧列表 */}
          <div className="w-full lg:w-1/2 xl:w-2/5">
            <div className="mb-4">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索技能名称或描述"
              />
            </div>

            <div className="space-y-6">
              {loading && skills.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <Card className="border-error/20">
                  <CardContent className="text-center">
                    <p className="text-error">{error}</p>
                  </CardContent>
                </Card>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Puzzle}
                  title={searchQuery ? '没有找到匹配的技能' : '暂无技能'}
                />
              ) : (
                <>
                  {manualUserSkills.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        用户级技能 ({manualUserSkills.length})
                      </h2>
                      <div className="space-y-2">
                        {manualUserSkills.map((skill) => (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            selected={selectedId === skill.id}
                            onSelect={() => setSelectedId(skill.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {syncedUserSkills.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        宿主机同步 ({syncedUserSkills.length})
                      </h2>
                      <div className="space-y-2">
                        {syncedUserSkills.map((skill) => (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            selected={selectedId === skill.id}
                            onSelect={() => setSelectedId(skill.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {projectSkills.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        项目级技能 ({projectSkills.length})
                      </h2>
                      <div className="space-y-2">
                        {projectSkills.map((skill) => (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            selected={selectedId === skill.id}
                            onSelect={() => setSelectedId(skill.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 右侧详情（桌面端） */}
          <div className="hidden lg:block lg:w-1/2 xl:w-3/5">
            <SkillDetail skillId={selectedId} onDeleted={() => setSelectedId(null)} />
          </div>
          </div>
        </div>

        {/* 移动端详情 */}
        {selectedId && (
          <div className="lg:hidden p-4">
            <SkillDetail skillId={selectedId} onDeleted={() => setSelectedId(null)} />
          </div>
        )}
      </div>
    </div>
  );
}
