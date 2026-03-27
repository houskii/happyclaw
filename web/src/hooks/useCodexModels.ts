import { useState, useEffect } from 'react';
import { api } from '../api/client';

export interface CodexModel {
  slug: string;
  displayName: string;
  description: string;
  priority: number;
  defaultReasoningLevel?: string;
  supportedReasoningLevels?: string[];
}

export interface CodexModelOption {
  value: string;
  label: string;
}

// 模块级缓存，组件间共享，避免重复请求
let codexModelsCache: CodexModel[] | null = null;
let codexModelsFetchPromise: Promise<void> | null = null;

const DEFAULT_OPTION: CodexModelOption = {
  value: '__default__',
  label: '默认（gpt-5.4）',
};

function buildOptions(models: CodexModel[]): CodexModelOption[] {
  return [
    DEFAULT_OPTION,
    ...models.map((m) => ({ value: m.slug, label: m.displayName })),
  ];
}

export function useCodexModels(enabled: boolean) {
  const [models, setModels] = useState<CodexModelOption[]>([DEFAULT_OPTION]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    if (codexModelsCache) {
      setModels(buildOptions(codexModelsCache));
      return;
    }

    setLoading(true);
    if (!codexModelsFetchPromise) {
      codexModelsFetchPromise = api
        .get<{ models: CodexModel[] }>('/api/config/codex/models')
        .then((res) => { codexModelsCache = res.models; })
        .catch(() => { codexModelsCache = []; })
        .finally(() => { codexModelsFetchPromise = null; });
    }
    codexModelsFetchPromise.then(() => {
      setModels(buildOptions(codexModelsCache!));
      setLoading(false);
    });
  }, [enabled]);

  return { models, loading };
}
