import { create } from 'zustand';
import { api } from '../api/client';
import type { HostIntegrationConflictItem } from '../types/host-integrations';

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project';
  enabled: boolean;
  syncedFromHost?: boolean;
  packageName?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

export interface SkillDetail extends Skill {
  content: string;
}

export interface SkillVariantDetail {
  itemId: string;
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
  content: string;
  enabled: boolean;
  name: string;
  description: string;
}

interface SkillsState {
  skills: Skill[];
  conflicts: HostIntegrationConflictItem[];
  loading: boolean;
  error: string | null;

  loadSkills: () => Promise<void>;
  updateConflict: (
    id: string,
    mode: 'auto' | 'pinned',
    pinnedSourceId?: string,
  ) => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  getSkillDetail: (id: string) => Promise<SkillDetail>;
  getSkillVariant: (id: string, sourceId: string) => Promise<SkillVariantDetail>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  conflicts: [],
  loading: false,
  error: null,

  loadSkills: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        skills: Skill[];
        conflicts: HostIntegrationConflictItem[];
      }>('/api/skills');
      set({
        skills: data.skills,
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
      await api.patch(`/api/skills/conflicts/${encodeURIComponent(id)}`, {
        mode,
        ...(mode === 'pinned' && pinnedSourceId ? { pinnedSourceId } : {}),
      });
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  toggleSkill: async (id: string, enabled: boolean) => {
    try {
      await api.patch(`/api/skills/${id}`, { enabled });
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteSkill: async (id: string) => {
    try {
      await api.delete(`/api/skills/${id}`);
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  getSkillDetail: async (id: string) => {
    const data = await api.get<{ skill: SkillDetail }>(`/api/skills/${id}`);
    return data.skill;
  },

  getSkillVariant: async (id: string, sourceId: string) => {
    const data = await api.get<{ variant: SkillVariantDetail }>(
      `/api/skills/${encodeURIComponent(id)}/variants/${encodeURIComponent(sourceId)}`,
    );
    return data.variant;
  },
}));
