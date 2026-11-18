import type { ThinkMode } from './types.js';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export interface ReasoningCapabilities {
  status: 'supported' | 'unsupported' | 'unknown';
  efforts: ReasoningEffort[];
  canEnable: boolean;
  canDisable: boolean;
  mandatory: boolean;
  defaultEffort?: ReasoningEffort;
  source: 'api' | 'rules' | 'unknown';
  detail: string;
}
export interface ModelCatalog {
  models: string[];
  model: string;
  reasoning: ReasoningCapabilities;
  /** 模型上下文窗口（token）。优先取接口返回值，其次 Provider 能力，最后回退默认。 */
  contextWindow: number;
  /** 单次响应的最大输出 token（接口返回时才有）。 */
  maxOutputTokens?: number;
  /** 输入模态，例如 ["text"] 或 ["text","image"]。 */
  inputModalities: string[];
  /** 模型/协议是否具备原生联网搜索。 */
  webSearch: boolean;
  /** 能否强制触发原生搜索（依赖接口是否支持 tool_choice 强约束）。 */
  forceSearch: boolean;
  warning?: string;
}
export const UNKNOWN_REASONING: ReasoningCapabilities = {
  status: 'unknown', efforts: [], canEnable: false, canDisable: false,
  mandatory: false, source: 'unknown', detail: '未获取到该模型的推理配置能力，使用模型默认行为。',
};
export const THINK_LABELS: Record<string, string> = {
  default: '模型默认', enabled: '开启思考', none: '关闭思考', minimal: '最低',
  low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高',
};
// 旧版 off 实际上是不传参数，不能将历史设置解释为显式关闭。
export function normalizeThinkMode(mode: ThinkMode): ThinkMode {
  return mode === 'off' ? 'default' : mode === 'standard' ? 'medium' : mode === 'deep' ? 'high' : mode;
}
export function reasoningOptions(cap: ReasoningCapabilities): ThinkMode[] {
  if (cap.status !== 'supported') return ['default'];
  return ['default', ...(cap.canDisable && !cap.mandatory ? ['none' as const] : []),
    ...(cap.canEnable && !cap.efforts.length ? ['enabled' as const] : []), ...cap.efforts.filter(e => e !== 'none')];
}
