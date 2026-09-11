import type { ProviderConfig, ThinkMode } from '../shared/types.js';
import { REASONING_EFFORTS, UNKNOWN_REASONING, normalizeThinkMode, reasoningOptions, type ReasoningCapabilities, type ReasoningEffort, type ModelCatalog } from '../shared/reasoning.js';
import { getSecret } from './secret.js';

export function providerBase(provider: Pick<ProviderConfig, 'type' | 'api_base'>): string {
  return (provider.api_base || ({ openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com/v1', openrouter: 'https://openrouter.ai/api/v1', custom: '' }[provider.type])).replace(/\/+$/, '');
}
export function reasoningProtocol(provider: Pick<ProviderConfig, 'type' | 'api_base'>): 'openai' | 'deepseek' | 'openrouter' | 'custom' {
  let host = '';
  try { host = new URL(providerBase(provider)).hostname; } catch { /* unknown custom address */ }
  if (host === 'openrouter.ai') return 'openrouter';
  if (host === 'api.deepseek.com') return 'deepseek';
  if (host === 'api.openai.com') return 'openai';
  return provider.type;
}
const isEffort = (v: unknown): v is ReasoningEffort => REASONING_EFFORTS.includes(v as ReasoningEffort);
const unsupported = (): ReasoningCapabilities => ({ ...UNKNOWN_REASONING, status: 'unsupported', source: 'api', detail: '该模型未提供可调推理设置。' });

export function parseReasoningMetadata(model: any): ReasoningCapabilities | null {
  const r = model?.reasoning;
  if (r && typeof r === 'object') {
    const mandatory = r.mandatory === true;
    const efforts = r.supported_efforts === null ? [...REASONING_EFFORTS]
      : Array.isArray(r.supported_efforts) ? REASONING_EFFORTS.filter(e => r.supported_efforts.includes(e)) : [];
    return {
      status: 'supported', efforts: efforts.filter(e => e !== 'none'),
      canEnable: r.supported_efforts === undefined || efforts.some(e => e !== 'none'), canDisable: !mandatory && (efforts.includes('none') || r.mandatory === false), mandatory,
      defaultEffort: isEffort(r.default_effort) ? r.default_effort : undefined,
      source: 'api', detail: efforts.length ? '根据模型接口返回的可用推理档位。' : '模型支持推理，但接口未提供强度档位；可使用默认思考设置。',
    };
  }
  if (Array.isArray(model?.supported_parameters)) {
    return model.supported_parameters.includes('reasoning')
      ? { ...UNKNOWN_REASONING, status: 'supported', canEnable: true, source: 'api', detail: '接口声明支持推理，但未提供可选强度或关闭能力。' }
      : unsupported();
  }
  return null;
}

// 官方 /models 未列出档位时的保守回退；只匹配已核实的 ID 和日期快照。
// 规则来源、核对日期见 docs/reasoning-controls.md。未知系列不按名称猜测。
export function documentedReasoning(protocol: string, model: string): ReasoningCapabilities {
  const id = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  let efforts: ReasoningEffort[] | undefined;
  let toggle = false;
  if (protocol === 'openai') {
    const rules: Record<string, ReasoningEffort[]> = {
      o1: ['low', 'medium', 'high'], o3: ['low', 'medium', 'high'], 'o3-mini': ['low', 'medium', 'high'], 'o4-mini': ['low', 'medium', 'high'],
      'gpt-5': ['minimal', 'low', 'medium', 'high'], 'gpt-5-mini': ['minimal', 'low', 'medium', 'high'], 'gpt-5-nano': ['minimal', 'low', 'medium', 'high'],
      'gpt-5.1': ['none', 'low', 'medium', 'high'],
      'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
      'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
      'gpt-5.4-mini': ['none', 'low', 'medium', 'high', 'xhigh'],
      'gpt-5.6': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
      'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
    };
    efforts = rules[id];
    if (/^gpt-4(?:o|\.1)?(?:-mini|-nano|-turbo)?$/.test(id) || id === 'gpt-3.5-turbo') return { ...unsupported(), source: 'rules' };
  }
  if (protocol === 'deepseek') {
    if (/^deepseek-v4-(flash|pro)(-\d{4})?$/.test(id)) efforts = ['none', 'low', 'high', 'max'];
    // 兼容历史别名：只暴露已知开关，不把别名当作固定版本来推测档位。
    if (id === 'deepseek-chat' || id === 'deepseek-reasoner') { efforts = []; toggle = true; }
  }
  if (!efforts) return { ...UNKNOWN_REASONING };
  return {
    status: 'supported', efforts: efforts.filter(e => e !== 'none'), canEnable: true,
    canDisable: toggle || efforts.includes('none'), mandatory: !toggle && !efforts.includes('none'),
    source: 'rules', detail: '接口未返回完整档位，使用已核实的官方模型规则。',
  };
}

type CachedModels = { rows: any[]; warning?: string };
const cache = new Map<string, { until: number; result: Promise<CachedModels> }>();
export function invalidateModelCache(id: string) {
  for (const key of cache.keys()) if (key.startsWith(`${id}:`)) cache.delete(key);
}
export async function getModelCatalog(provider: ProviderConfig, model: string, refresh = false): Promise<ModelCatalog> {
  const base = providerBase(provider);
  const key = `${provider.id}:${provider.config_version}:${base}`;
  if (refresh) invalidateModelCache(provider.id);
  let entry = cache.get(key);
  if (!entry || entry.until < Date.now()) {
    const result = (async (): Promise<CachedModels> => {
      try {
        const secret = provider.has_secret ? await getSecret(provider.secret_ref) : null;
        const response = await fetch(`${base}/models`, {
          headers: secret ? { Authorization: `Bearer ${secret}` } : {},
          signal: AbortSignal.timeout(8000), redirect: 'error',
        });
        if (!response.ok) throw new Error(`模型列表读取失败（HTTP ${response.status}）`);
        const body: any = await response.json();
        if (!Array.isArray(body.data)) throw new Error('模型列表格式不兼容');
        return { rows: body.data.filter((r: any) => typeof r?.id === 'string') };
      } catch {
        return { rows: [], warning: '暂时无法读取模型接口；已知模型使用兼容规则，其他模型保持默认。' };
      }
    })();
    entry = { until: Date.now() + 5 * 60_000, result };
    cache.set(key, entry);
    void result.then(r => { if (r.warning && cache.get(key) === entry) entry!.until = Date.now() + 15_000; });
  }
  const { rows, warning } = await entry.result;
  const row = rows.find(r => r.id === model);
  const protocol = reasoningProtocol(provider);
  const reasoning = parseReasoningMetadata(row) ?? documentedReasoning(protocol, model);
  if (protocol === "openai" && !reasoning.efforts.length) reasoning.canEnable = false;
  return { models: [...new Set([model, provider.default_model, ...rows.map(r => r.id)].filter(Boolean))], model, reasoning, warning };
}

export function reasoningRequest(mode: ThinkMode, cap: ReasoningCapabilities, protocol: string, responses = false): Record<string, unknown> {
  const selected = normalizeThinkMode(mode);
  if (selected === 'default') return {};
  if (!reasoningOptions(cap).includes(selected)) throw new Error('当前模型不支持所选推理设置，请刷新模型能力或选择“模型默认”。');
  if (protocol === 'openrouter' || protocol === 'custom') return {
    reasoning: selected === 'enabled' ? { enabled: true } : selected === 'none' ? { enabled: false } : { effort: selected },
    ...(protocol === 'openrouter' ? { provider: { require_parameters: true } } : {}),
  };
  if (protocol === 'deepseek' && !responses) return { thinking: { type: selected === 'none' ? 'disabled' : 'enabled' }, ...(selected === 'none' || selected === 'enabled' ? {} : { reasoning_effort: selected }) };
  if (selected === 'enabled') throw new Error('当前接口未提供可用的默认思考开关，请使用“模型默认”。');
  return responses ? { reasoning: { effort: selected } } : { reasoning_effort: selected };
}
