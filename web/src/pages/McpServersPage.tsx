import { useEffect, useState, useMemo } from 'react';
import { Plus, RefreshCw, Server } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMcpServersStore } from '../stores/mcp-servers';
import { useHostIntegrationsStore } from '../stores/host-integrations';
import { useAuthStore } from '../stores/auth';
import { McpServerCard } from '../components/mcp-servers/McpServerCard';
import { McpServerDetail } from '../components/mcp-servers/McpServerDetail';
import { AddMcpServerDialog } from '../components/mcp-servers/AddMcpServerDialog';
import { HostIntegrationsPanel } from '../components/settings/HostIntegrationsPanel';

export function McpServersPage() {
  const {
    servers,
    loading,
    error,
    loadServers,
    addServer,
  } = useMcpServersStore();
  const loadHostIntegrations = useHostIntegrationsStore((s) => s.load);

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);

  useEffect(() => {
    loadServers();
    loadHostIntegrations();
  }, [loadServers, loadHostIntegrations]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return servers.filter(
      (s) =>
        !q ||
        s.id.toLowerCase().includes(q) ||
        (s.command && s.command.toLowerCase().includes(q)) ||
        (s.url && s.url.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q)),
    );
  }, [servers, searchQuery]);

  const manualServers = filtered.filter((s) => !s.syncedFromHost);
  const syncedServers = filtered.filter((s) => s.syncedFromHost);

  const enabledCount = servers.filter((s) => s.enabled).length;
  const selectedServer = servers.find((s) => s.id === selectedId) || null;

  const handleAdd = async (server: Parameters<typeof addServer>[0]) => {
    await addServer(server);
  };

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="MCP 服务器"
            subtitle={`共 ${servers.length} 个${syncedServers.length > 0 ? `（含同步 ${syncedServers.length}）` : ''} · 启用 ${enabledCount}`}
            actions={
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={loadServers} disabled={loading}>
                  <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                  刷新
                </Button>
                <Button onClick={() => setShowAddDialog(true)}>
                  <Plus size={18} />
                  添加
                </Button>
              </div>
            }
          />
        </div>

        {/* Content */}
        <div className="space-y-4 p-4">
          <HostIntegrationsPanel
            isAdmin={isAdmin}
            target="mcp"
            onSynced={loadServers}
          />

          <div className="flex gap-6">
          {/* Left list */}
          <div className="w-full lg:w-1/2 xl:w-2/5">
            <div className="mb-4">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索 ID、命令或 URL"
              />
            </div>

            <div className="space-y-6">
              {loading && servers.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <Card className="border-error/20">
                  <CardContent className="text-center">
                    <p className="text-error">{error}</p>
                  </CardContent>
                </Card>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title={searchQuery ? '没有找到匹配的 MCP 服务器' : '暂无 MCP 服务器'}
                  description={searchQuery ? undefined : '点击"添加"按钮添加第一个 MCP 服务器'}
                />
              ) : (
                <>
                  {manualServers.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        手动添加 ({manualServers.length})
                      </h2>
                      <div className="space-y-2">
                        {manualServers.map((server) => (
                          <McpServerCard
                            key={server.id}
                            server={server}
                            selected={selectedId === server.id}
                            onSelect={() => setSelectedId(server.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {syncedServers.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        宿主机同步 ({syncedServers.length})
                      </h2>
                      <div className="space-y-2">
                        {syncedServers.map((server) => (
                          <McpServerCard
                            key={server.id}
                            server={server}
                            selected={selectedId === server.id}
                            onSelect={() => setSelectedId(server.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right detail (desktop) */}
          <div className="hidden lg:block lg:w-1/2 xl:w-3/5">
            <McpServerDetail server={selectedServer} onDeleted={() => setSelectedId(null)} />
          </div>
          </div>
        </div>

        {/* Mobile detail */}
        {selectedId && selectedServer && (
          <div className="lg:hidden p-4">
            <McpServerDetail server={selectedServer} onDeleted={() => setSelectedId(null)} />
          </div>
        )}
      </div>

      <AddMcpServerDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onAdd={handleAdd}
      />
    </div>
  );
}
