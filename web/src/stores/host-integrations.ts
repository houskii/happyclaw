import { create } from 'zustand';
import { api } from '../api/client';
import type {
  HostIntegrationSource,
  HostIntegrationsResponse,
  HostIntegrationsSyncResponse,
} from '../components/settings/types';

interface HostIntegrationsState {
  sources: HostIntegrationsResponse['sources'];
  skills: HostIntegrationsResponse['skills'];
  mcp: HostIntegrationsResponse['mcp'];
  loading: boolean;
  saving: boolean;
  syncing: boolean;
  error: string | null;

  load: () => Promise<void>;
  save: (sources: HostIntegrationSource[]) => Promise<void>;
  sync: () => Promise<HostIntegrationsSyncResponse>;
}

const emptySnapshot = {
  lastSyncAt: null,
  syncedCount: 0,
};

export const useHostIntegrationsStore = create<HostIntegrationsState>((set) => ({
  sources: [],
  skills: emptySnapshot,
  mcp: emptySnapshot,
  loading: false,
  saving: false,
  syncing: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<HostIntegrationsResponse>('/api/host-integrations');
      set({
        sources: data.sources,
        skills: data.skills,
        mcp: data.mcp,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  save: async (sources) => {
    set({ saving: true, error: null });
    try {
      const data = await api.put<{ sources: HostIntegrationsResponse['sources'] }>(
        '/api/host-integrations',
        { sources },
      );
      set({
        sources: data.sources,
        saving: false,
        error: null,
      });
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  sync: async () => {
    set({ syncing: true, error: null });
    try {
      const result = await api.post<HostIntegrationsSyncResponse>('/api/host-integrations/sync', {});
      const data = await api.get<HostIntegrationsResponse>('/api/host-integrations');
      set({
        sources: data.sources,
        skills: data.skills,
        mcp: data.mcp,
        syncing: false,
        error: null,
      });
      return result;
    } catch (err) {
      set({
        syncing: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
}));
