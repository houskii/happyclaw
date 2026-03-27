import { useEffect, useState, useRef, useCallback } from 'react';
import { Loader2, Save, Plus, X, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import { useContainerEnvStore } from '../../stores/container-env';
import { useGroupsStore } from '../../stores/groups';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCodexModels } from '@/hooks/useCodexModels';

interface ContainerEnvPanelProps {
  groupJid: string;
  onClose?: () => void;
}

const CLAUDE_MODEL_OPTIONS = [
  { value: '__default__', label: '默认（跟随全局配置）' },
  { value: 'opus', label: 'Opus（最强）' },
  { value: 'sonnet', label: 'Sonnet（均衡）' },
  { value: 'haiku', label: 'Haiku（快速/低成本）' },
];

const THINKING_EFFORT_OPTIONS = [
  { value: '__default__', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export function ContainerEnvPanel({ groupJid, onClose }: ContainerEnvPanelProps) {
  const { configs, loading, saving, loadConfig, saveConfig } = useContainerEnvStore();
  const config = configs[groupJid];
  const { groups, loadGroups } = useGroupsStore();
  const group = groups[groupJid];

  const currentProvider = group?.llm_provider || 'claude';
  const isCodex = currentProvider === 'openai';
  const { models: codexModelOptions, loading: codexModelsLoading } = useCodexModels(isCodex);

  // Provider-level state (instant save via PATCH)
  const [model, setModel] = useState(group?.model || '__default__');
  const [thinkingEffort, setThinkingEffort] = useState(group?.thinking_effort || '__default__');

  // Claude connection config state (batch save)
  const [baseUrl, setBaseUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [customEnv, setCustomEnv] = useState<{ key: string; value: string }[]>([]);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [clearing, setClearing] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (groupJid) {
      loadConfig(groupJid);
      loadGroups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Sync provider-level state when group changes
  useEffect(() => {
    setModel(group?.model || '__default__');
    setThinkingEffort(group?.thinking_effort || '__default__');
  }, [group?.model, group?.llm_provider, group?.thinking_effort]);

  // Sync config to draft when loaded
  useEffect(() => {
    if (!config) return;
    setBaseUrl(config.anthropicBaseUrl || '');
    setAuthToken('');
    setAuthTokenDirty(false);
    const entries = Object.entries(config.customEnv || {}).map(([key, value]) => ({ key, value }));
    setCustomEnv(entries.filter(({ key }) => key !== 'ANTHROPIC_MODEL'));
  }, [config]);

  const patchGroup = useCallback(async (updates: Record<string, unknown>) => {
    try {
      await api.patch(`/api/groups/${encodeURIComponent(groupJid)}`, updates);
      await loadGroups();
    } catch { /* ignore */ }
  }, [groupJid, loadGroups]);

  const handleProviderChange = useCallback(async (value: string) => {
    if (value === currentProvider) return;
    if (!window.confirm(
      '切换 Provider 将开始新对话，当前上下文不会继承。\n确定要切换吗？'
    )) return;
    await patchGroup({ llm_provider: value, model: null, thinking_effort: null });
  }, [currentProvider, patchGroup]);

  const handleModelChange = useCallback(async (value: string) => {
    setModel(value);
    await patchGroup({ model: value === '__default__' ? null : value });
  }, [patchGroup]);

  const handleThinkingEffortChange = useCallback(async (value: string) => {
    setThinkingEffort(value);
    await patchGroup({ thinking_effort: value === '__default__' ? null : value });
  }, [patchGroup]);

  const handleSave = async () => {
    const data: Record<string, unknown> = {};
    data.anthropicBaseUrl = baseUrl;
    if (authTokenDirty) data.anthropicAuthToken = authToken;

    const envMap: Record<string, string> = {};
    for (const { key, value } of customEnv) {
      const k = key.trim();
      if (!k || k === 'ANTHROPIC_MODEL') continue;
      envMap[k] = value;
    }
    data.customEnv = envMap;

    const ok = await saveConfig(groupJid, data as {
      anthropicBaseUrl?: string;
      anthropicAuthToken?: string;
      customEnv?: Record<string, string>;
    });
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
      setAuthToken('');
      setAuthTokenDirty(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('确定要清空所有覆盖配置并重建工作区吗？')) return;
    setClearing(true);
    const ok = await saveConfig(groupJid, {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      customEnv: {},
    });
    setClearing(false);
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
    }
  };

  const addCustomEnv = () => {
    setCustomEnv((prev) => [...prev, { key: '', value: '' }]);
  };

  const removeCustomEnv = (index: number) => {
    setCustomEnv((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCustomEnv = (index: number, field: 'key' | 'value', val: string) => {
    setCustomEnv((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: val } : item))
    );
  };

  const modelOptions = isCodex ? codexModelOptions : CLAUDE_MODEL_OPTIONS;

  if (loading && !config) {
    return (
      <div className="p-4 text-sm text-slate-400 text-center">加载中...</div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="font-semibold text-slate-900 text-sm">工作区配置</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadConfig(groupJid)}
            className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 cursor-pointer"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">

        {/* ── Section 1: LLM Provider 配置 ── */}
        <div className="space-y-3">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">LLM Provider</div>

          {/* Provider Selector */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Provider
            </label>
            <Select value={currentProvider} onValueChange={handleProviderChange}>
              <SelectTrigger className="text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                <SelectItem value="openai">OpenAI (Codex)</SelectItem>
              </SelectContent>
            </Select>
            {/* Context warning */}
            <div className="flex items-start gap-1.5 mt-1.5 px-2 py-1.5 rounded bg-amber-50 border border-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-700 leading-relaxed">
                切换 Provider 会开始新对话，当前上下文不会继承。
              </p>
            </div>
          </div>

          {/* Model Selector */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              模型
            </label>
            <Select
              value={model}
              onValueChange={handleModelChange}
              disabled={isCodex && codexModelsLoading}
            >
              <SelectTrigger className="text-xs h-8">
                <SelectValue placeholder={codexModelsLoading ? '加载模型列表...' : '默认'} />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-slate-400 mt-1">
              选择后立即生效，下次对话将使用新模型。
            </p>
          </div>

          {/* Thinking Effort */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Thinking Effort
            </label>
            <Select value={thinkingEffort} onValueChange={handleThinkingEffortChange}>
              <SelectTrigger className="text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THINKING_EFFORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-slate-400 mt-1">
              控制模型的推理深度。低=快速响应，高=深度思考。
            </p>
          </div>
        </div>

        {/* ── Section 2: Claude 连接配置 ── */}
        {!isCodex && (
          <>
            <div className="border-t border-slate-100" />
            <div className="space-y-3">
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">连接配置</div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  ANTHROPIC_BASE_URL
                </label>
                <Input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="留空使用全局配置"
                  className="px-2.5 py-1.5 text-xs h-auto"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  ANTHROPIC_AUTH_TOKEN
                  {config?.hasAnthropicAuthToken && (
                    <span className="ml-1.5 text-[10px] text-slate-400 font-normal">
                      ({config.anthropicAuthTokenMasked})
                    </span>
                  )}
                </label>
                <Input
                  type="password"
                  value={authToken}
                  onChange={(e) => {
                    setAuthToken(e.target.value);
                    setAuthTokenDirty(true);
                  }}
                  placeholder={config?.hasAnthropicAuthToken ? '已设置，输入新值覆盖；留空可清除覆盖' : '留空使用全局配置'}
                  className="px-2.5 py-1.5 text-xs h-auto"
                />
              </div>
            </div>
          </>
        )}

        {/* ── Section 3: 自定义环境变量 ── */}
        <div className="border-t border-slate-100" />
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">自定义环境变量</div>
            <button
              onClick={addCustomEnv}
              className="flex-shrink-0 flex items-center gap-1 text-[11px] text-primary hover:text-primary cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              添加
            </button>
          </div>

          {customEnv.length === 0 ? (
            <p className="text-[11px] text-slate-400">暂无自定义变量</p>
          ) : (
            <div className="space-y-1.5">
              {customEnv.map((item, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    value={item.key}
                    onChange={(e) => updateCustomEnv(i, 'key', e.target.value)}
                    placeholder="KEY"
                    className="w-[40%] px-2 py-1 text-[11px] font-mono h-auto"
                  />
                  <span className="text-slate-300 text-xs">=</span>
                  <Input
                    type="text"
                    value={item.value}
                    onChange={(e) => updateCustomEnv(i, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-1 px-2 py-1 text-[11px] font-mono h-auto"
                  />
                  <button
                    onClick={() => removeCustomEnv(i)}
                    className="flex-shrink-0 p-1 text-slate-400 hover:text-red-500 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
            覆盖全局配置，仅对当前工作区生效。保存后工作区将自动重建。
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-3 border-t border-slate-200 space-y-2">
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || clearing} className="flex-1" size="sm">
            {saving && <Loader2 className="size-4 animate-spin" />}
            <Save className="w-4 h-4" />
            {saveSuccess ? '已保存' : '保存并重建工作区'}
          </Button>
          <Button
            onClick={handleClear}
            disabled={saving || clearing}
            variant="outline"
            size="sm"
            title="清空所有覆盖配置"
          >
            {clearing && <Loader2 className="size-4 animate-spin" />}
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
        {saveSuccess && (
          <p className="text-[11px] text-primary text-center">
            配置已保存，工作区已重建
          </p>
        )}
      </div>
    </div>
  );
}
