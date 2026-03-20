import { useCallback, useEffect, useState, useRef } from 'react';
import { Check, ExternalLink, Key, Loader2, LogIn, RefreshCw, Unplug } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface OpenAIConfigPublic {
  authMode: 'api_key' | 'chatgpt_oauth';
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  baseUrl: string;
  model: string;
  proxyUrl: string;
  hasOAuth: boolean;
  oauthExpired: boolean;
  updatedAt: string | null;
}

interface DeviceCodeResponse {
  userCode: string;
  verificationUrl: string;
  deviceAuthId: string;
  expiresIn: number;
  interval: number;
}

interface OpenAIProviderSectionProps extends SettingsNotification {}

export function OpenAIProviderSection({ setNotice, setError }: OpenAIProviderSectionProps) {
  const [config, setConfig] = useState<OpenAIConfigPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // API Key form
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');

  // OAuth state — Device Code (fallback)
  const [oauthPolling, setOauthPolling] = useState(false);
  const [deviceCode, setDeviceCode] = useState<DeviceCodeResponse | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // OAuth state — PKCE (primary)
  const [pkceUrl, setPkceUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [pkceSubmitting, setPkceSubmitting] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.get<OpenAIConfigPublic>('/api/config/openai');
      setConfig(data);
      setBaseUrl(data.baseUrl || '');
      setModel(data.model || '');
      setProxyUrl(data.proxyUrl || '');
    } catch (err) {
      setError(getErrorMessage(err, '加载 OpenAI 配置失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Cleanup poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // ── Save API Key ──────────────────────────────────────────

  const handleSaveApiKey = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/api/config/openai', {
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
        model: model || undefined,
      });
      setApiKey('');
      setNotice('OpenAI API Key 已保存');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  }, [apiKey, baseUrl, model, setNotice, setError, loadConfig]);

  // ── Save model/baseUrl only ───────────────────────────────

  const handleSaveSettings = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch('/api/config/openai', {
        baseUrl: baseUrl || undefined,
        model: model || undefined,
        proxyUrl: proxyUrl || '',
      });
      setNotice('设置已更新');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  }, [baseUrl, model, proxyUrl, setNotice, setError, loadConfig]);

  // ── OAuth Device Code Flow ────────────────────────────────

  const startOAuthLogin = useCallback(async () => {
    setError(null);
    try {
      const data = await api.post<DeviceCodeResponse>('/api/config/openai/oauth/login', undefined, 30000);
      setDeviceCode(data);
      setOauthPolling(true);

      // Start polling
      const interval = (data.interval || 5) * 1000;
      pollTimerRef.current = setInterval(async () => {
        try {
          const result = await api.post<{ status: string; error?: string }>('/api/config/openai/oauth/poll', {
            deviceAuthId: data.deviceAuthId,
            model: model || undefined,
          });
          if (result.status === 'complete') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setOauthPolling(false);
            setDeviceCode(null);
            setNotice('ChatGPT OAuth 登录成功！');
            await loadConfig();
          } else if (result.status === 'expired') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setOauthPolling(false);
            setDeviceCode(null);
            setError('验证码已过期，请重新登录');
          } else if (result.status === 'error') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setOauthPolling(false);
            setDeviceCode(null);
            setError(result.error || 'OAuth 登录失败');
          }
          // status === 'pending' → continue polling
        } catch {
          // Network error during poll — keep trying
        }
      }, interval);

      // Auto-stop after expiry
      setTimeout(() => {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setOauthPolling(false);
        setDeviceCode(null);
      }, data.expiresIn * 1000);
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 登录初始化失败'));
    }
  }, [model, setNotice, setError, loadConfig]);

  const cancelOAuth = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setOauthPolling(false);
    setDeviceCode(null);
  }, []);

  const disconnectOAuth = useCallback(async () => {
    setError(null);
    try {
      await api.post('/api/config/openai/oauth/disconnect');
      setNotice('ChatGPT OAuth 已断开');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '断开失败'));
    }
  }, [setNotice, setError, loadConfig]);

  const copyCode = useCallback(async () => {
    if (!deviceCode) return;
    try {
      await navigator.clipboard.writeText(deviceCode.userCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch { /* ignore */ }
  }, [deviceCode]);

  // ── PKCE Browser Flow ──────────────────────────────────────

  const startPkceLogin = useCallback(async () => {
    setError(null);
    try {
      const data = await api.post<{ authorizeUrl: string }>('/api/config/openai/oauth/pkce-init');
      setPkceUrl(data.authorizeUrl);
      setCallbackUrl('');
    } catch (err) {
      setError(getErrorMessage(err, '生成登录链接失败'));
    }
  }, [setError]);

  const submitPkceCallback = useCallback(async () => {
    if (!callbackUrl.trim()) return;
    setPkceSubmitting(true);
    setError(null);
    try {
      await api.post<{ success: boolean }>('/api/config/openai/oauth/pkce-callback', {
        callbackUrl: callbackUrl.trim(),
        model: model || undefined,
      });
      setPkceUrl(null);
      setCallbackUrl('');
      setNotice('ChatGPT OAuth 登录成功！');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 回调处理失败'));
    } finally {
      setPkceSubmitting(false);
    }
  }, [callbackUrl, model, setNotice, setError, loadConfig]);

  const cancelPkce = useCallback(() => {
    setPkceUrl(null);
    setCallbackUrl('');
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> 加载中...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status Overview */}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
        <div className={`w-2.5 h-2.5 rounded-full ${config?.hasApiKey || config?.hasOAuth ? 'bg-green-500' : 'bg-slate-300'}`} />
        <div className="text-sm">
          {config?.hasOAuth && !config.oauthExpired && (
            <span className="text-green-700 font-medium">ChatGPT OAuth 已连接</span>
          )}
          {config?.hasOAuth && config.oauthExpired && (
            <span className="text-amber-700 font-medium">ChatGPT OAuth 已过期（需重新登录）</span>
          )}
          {!config?.hasOAuth && config?.hasApiKey && (
            <span className="text-green-700 font-medium">API Key 已配置 ({config.apiKeyMasked})</span>
          )}
          {!config?.hasOAuth && !config?.hasApiKey && (
            <span className="text-slate-500">未配置认证信息</span>
          )}
        </div>
        <button onClick={loadConfig} className="ml-auto p-1 rounded hover:bg-slate-200 transition-colors" title="刷新">
          <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
        </button>
      </div>

      {/* ChatGPT OAuth Section */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <LogIn className="w-4 h-4" />
          ChatGPT 订阅登录（推荐）
        </h3>
        <p className="text-xs text-slate-500">
          使用 ChatGPT Plus/Pro/Team 订阅账号登录，无需 API Key。
        </p>

        {/* PKCE Flow (primary) */}
        {pkceUrl ? (
          <div className="p-4 rounded-lg border border-teal-200 bg-teal-50 space-y-3">
            <p className="text-sm text-teal-800 font-medium">步骤 1：在浏览器中打开以下链接并登录</p>
            <div className="flex items-center gap-2">
              <a
                href={pkceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-teal-700 underline font-mono break-all line-clamp-2"
              >
                {pkceUrl.slice(0, 80)}...
              </a>
              <a href={pkceUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4 text-teal-600 shrink-0" />
              </a>
            </div>

            <p className="text-sm text-teal-800 font-medium">步骤 2：登录后浏览器会跳转到一个打不开的页面，复制地址栏的完整 URL 粘贴到这里</p>
            <div className="flex items-center gap-2">
              <Input
                placeholder="http://localhost:1455/auth/callback?code=..."
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                className="font-mono text-xs"
              />
              <Button
                onClick={submitPkceCallback}
                disabled={pkceSubmitting || !callbackUrl.trim()}
                size="sm"
              >
                {pkceSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={cancelPkce}>取消</Button>
          </div>

        /* Device Code Flow (fallback, when proxy is configured) */
        ) : deviceCode && oauthPolling ? (
          <div className="p-4 rounded-lg border border-teal-200 bg-teal-50 space-y-3">
            <p className="text-sm text-teal-800">
              请在浏览器中访问以下地址，并输入验证码：
            </p>
            <div className="flex items-center gap-3">
              <a
                href={deviceCode.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-teal-700 underline font-mono"
              >
                {deviceCode.verificationUrl}
              </a>
            </div>
            <div className="flex items-center gap-3">
              <code className="text-2xl font-bold tracking-widest text-teal-900 bg-white px-4 py-2 rounded border border-teal-300">
                {deviceCode.userCode}
              </code>
              <Button variant="outline" size="sm" onClick={copyCode}>
                {codeCopied ? <Check className="w-3.5 h-3.5" /> : '复制'}
              </Button>
            </div>
            <div className="flex items-center gap-2 text-xs text-teal-600">
              <Loader2 className="w-3 h-3 animate-spin" />
              等待授权中... 验证码将在 {Math.floor(deviceCode.expiresIn / 60)} 分钟后过期
            </div>
            <Button variant="ghost" size="sm" onClick={cancelOAuth}>取消</Button>
          </div>

        ) : config?.hasOAuth ? (
          <div className="flex items-center gap-3">
            <div className={`px-3 py-1.5 rounded-full text-xs font-medium ${
              config.oauthExpired ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
            }`}>
              {config.oauthExpired ? '已过期' : '已连接'}
            </div>
            <Button variant="outline" size="sm" onClick={startPkceLogin}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              重新登录
            </Button>
            <Button variant="ghost" size="sm" onClick={disconnectOAuth} className="text-red-600 hover:text-red-700">
              <Unplug className="w-3.5 h-3.5 mr-1.5" />
              断开
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button onClick={startPkceLogin}>
              <LogIn className="w-4 h-4 mr-2" />
              使用 ChatGPT 账号登录
            </Button>
            {config?.proxyUrl && (
              <Button variant="outline" onClick={startOAuthLogin} disabled={oauthPolling} size="sm">
                Device Code 模式
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-slate-200" />

      {/* API Key Section */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Key className="w-4 h-4" />
          API Key（备选）
        </h3>
        <p className="text-xs text-slate-500">
          使用 OpenAI API Key 直接调用 Chat Completions API。需要有 API 余额。
        </p>
        <div className="space-y-2">
          <div>
            <label className="text-xs text-slate-500 mb-1 block">API Key</label>
            <Input
              type="password"
              placeholder={config?.hasApiKey ? `当前: ${config.apiKeyMasked}` : 'sk-...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <Button onClick={handleSaveApiKey} disabled={saving || !apiKey.trim()} size="sm">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            保存 API Key
          </Button>
        </div>
      </div>

      <div className="border-t border-slate-200" />

      {/* Model & Base URL */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-700">模型与端点</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-500 mb-1 block">模型</label>
            <Input
              placeholder="gpt-5.4"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1 block">Base URL（可选，用于兼容 API）</label>
            <Input
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">HTTPS 代理（可选，用于 OAuth 认证请求）</label>
          <Input
            placeholder="http://proxy.example.com:8080 或 socks5://..."
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
          />
          <p className="text-xs text-slate-400 mt-1">
            如果服务器无法直接访问 auth.openai.com（如被 Cloudflare 拦截），可配置代理。
          </p>
        </div>
        <Button onClick={handleSaveSettings} disabled={saving} size="sm" variant="outline">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
          更新设置
        </Button>
      </div>

      {config?.updatedAt && (
        <p className="text-xs text-slate-400">
          上次更新: {new Date(config.updatedAt).toLocaleString('zh-CN')}
        </p>
      )}
    </div>
  );
}
