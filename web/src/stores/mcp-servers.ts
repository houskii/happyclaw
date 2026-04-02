import { create } from 'zustand';
import { api } from '../api/client';
import type { HostIntegrationConflictItem } from '../types/host-integrations';

export interface McpServer {
  id: string;
  // stdio type
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse type
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  // metadata
  enabled: boolean;
  syncedFromHost?: boolean;
  description?: string;
  addedAt: string;
}

export interface McpServerVariantDetail {
  itemId: string;
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
  entry: Record<string, unknown>;
}

interface McpServersState {
  servers: McpServer[];
  conflicts: HostIntegrationConflictItem[];
  loading: boolean;
  error: string | null;

  loadServers: () => Promise<void>;
  updateConflict: (
    id: string,
    mode: 'auto' | 'pinned',
    pinnedSourceId?: string,
  ) => Promise<void>;
  addServer: (server: {
    id: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    type?: 'http' | 'sse';
    url?: string;
    headers?: Record<string, string>;
    description?: string;
  }) => Promise<void>;
  updateServer: (id: string, updates: Partial<McpServer>) => Promise<void>;
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  getServerVariant: (
    id: string,
    sourceId: string,
  ) => Promise<McpServerVariantDetail>;
}

export const useMcpServersStore = create<McpServersState>((set, get) => ({
  servers: [],
  conflicts: [],
  loading: false,
  error: null,

  loadServers: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        servers: McpServer[];
        conflicts: HostIntegrationConflictItem[];
      }>('/api/mcp-servers');
      set({
        servers: data.servers,
        conflicts: data.conflicts,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  updateConflict: async (id, mode, pinnedSourceId) => {
    try {
      await api.patch(`/api/mcp-servers/conflicts/${encodeURIComponent(id)}`, {
        mode,
        ...(mode === 'pinned' && pinnedSourceId ? { pinnedSourceId } : {}),
      });
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  addServer: async (server) => {
    try {
      await api.post('/api/mcp-servers', server);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  updateServer: async (id, updates) => {
    try {
      await api.patch(`/api/mcp-servers/${encodeURIComponent(id)}`, updates);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  toggleServer: async (id, enabled) => {
    try {
      await api.patch(`/api/mcp-servers/${encodeURIComponent(id)}`, { enabled });
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteServer: async (id) => {
    try {
      await api.delete(`/api/mcp-servers/${encodeURIComponent(id)}`);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  getServerVariant: async (id, sourceId) => {
    const data = await api.get<{ variant: McpServerVariantDetail }>(
      `/api/mcp-servers/${encodeURIComponent(id)}/variants/${encodeURIComponent(sourceId)}`,
    );
    return data.variant;
  },
}));
