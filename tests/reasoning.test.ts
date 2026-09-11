import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelCatalog, invalidateModelCache, documentedReasoning, parseReasoningMetadata, reasoningProtocol, reasoningRequest } from '../src/server/model-capabilities.js';
import { reasoningOptions, UNKNOWN_REASONING } from '../src/shared/reasoning.js';
import { OpenAIAdapter, DeepSeekAdapter, CustomAdapter } from '../src/server/adapters/openai.js';
import type { ProviderConfig, ThinkMode } from '../src/shared/types.js';
vi.mock('../src/server/secret.js', () => ({ getSecret: vi.fn(async () => 'test-only-key') }));
const provider = { id: 'reasoning-test', type: 'openrouter', api_base: '', config_version: 1, default_model: 'example/model', has_secret: true, secret_ref: 'test' } as ProviderConfig;
afterEach(() => { vi.unstubAllGlobals(); invalidateModelCache(provider.id); });

describe('per-model reasoning capability', () => {
  it('reads exact effort levels and disallows off for mandatory models', () => {
    const cap = parseReasoningMetadata({ reasoning: { supported_efforts: ['high', 'low', 'bogus'], mandatory: true } })!;
    expect(reasoningOptions(cap)).toEqual(['default', 'low', 'high']);
    expect(() => reasoningRequest('none', cap, 'openrouter')).toThrow();
  });
  it('distinguishes null gateway efforts, omitted efforts, and unsupported models', () => {
    const all = parseReasoningMetadata({ reasoning: { supported_efforts: null, mandatory: false } })!;
    expect(reasoningOptions(all)).toEqual(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const toggle = parseReasoningMetadata({ reasoning: { mandatory: false } })!;
    expect(reasoningOptions(toggle)).toEqual(['default', 'none', 'enabled']);
    expect(reasoningOptions(parseReasoningMetadata({ supported_parameters: ['reasoning'] })!)).toEqual(['default', 'enabled']);
    expect(reasoningOptions(parseReasoningMetadata({ supported_parameters: ['temperature'] })!)).toEqual(['default']);
  });
  it('does not infer capability from unknown future names or third-party model names', () => {
    expect(documentedReasoning('openai', 'gpt-99').status).toBe('unknown');
    expect(documentedReasoning('custom', 'gpt-5.4').status).toBe('unknown');
    expect(documentedReasoning('openai', 'gpt-5.4-pro').status).toBe('unknown');
    expect(documentedReasoning('openai', 'gpt-4o-mini').status).toBe('unsupported');
    expect(documentedReasoning('openai', 'gpt-5.4-2026-03-05').efforts).toContain('xhigh');
  });
  it('distinguishes DeepSeek toggles from explicit v4 effort settings', () => {
    expect(reasoningOptions(documentedReasoning('deepseek', 'deepseek-chat'))).toEqual(['default', 'none', 'enabled']);
    expect(reasoningOptions(documentedReasoning('deepseek', 'deepseek-v4-pro'))).toEqual(['default', 'none', 'low', 'high', 'max']);
  });
  it('detects existing custom OpenRouter configurations by hostname, not display name', () => {
    expect(reasoningProtocol({ type: 'custom', api_base: 'https://openrouter.ai/api/v1' })).toBe('openrouter');
    expect(reasoningProtocol({ type: 'custom', api_base: 'https://openrouter.ai.evil.test/api/v1' })).toBe('custom');
  });
  it('caches model metadata, refreshes explicitly and isolates provider versions', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ data: [{ id: 'example/model', reasoning: { supported_efforts: ['low', 'high'], mandatory: true } }, { id: 'plain', supported_parameters: [] }] }));
    vi.stubGlobal('fetch', fetcher);
    expect((await getModelCatalog(provider, 'example/model')).reasoning.efforts).toEqual(['low', 'high']);
    expect((await getModelCatalog(provider, 'plain')).reasoning.status).toBe('unsupported');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await getModelCatalog(provider, 'example/model', true);
    await getModelCatalog({ ...provider, config_version: 2 }, 'example/model');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/models');
  });
  it('falls back honestly on network errors and never exposes server errors/secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test-only-key'); }));
    const result = await getModelCatalog(provider, 'unknown/model');
    expect(result.reasoning.status).toBe('unknown');
    expect(result.warning).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('test-only-key');
    const known = await getModelCatalog({ ...provider, type: 'openai' }, 'gpt-5.4', true);
    expect(known.reasoning.source).toBe('rules');
  });
  it('API metadata takes priority over documented fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'gpt-5.4', reasoning: { supported_efforts: ['high'], mandatory: true } }] })));
    expect((await getModelCatalog({ ...provider, type: 'openai' }, 'gpt-5.4')).reasoning.efforts).toEqual(['high']);
  });
});

describe('outgoing reasoning requests', () => {
  it('does not change legacy off into disabling mandatory reasoning', () => {
    expect(reasoningRequest('off', UNKNOWN_REASONING, 'openrouter')).toEqual({});
    expect(reasoningRequest('default', UNKNOWN_REASONING, 'openai')).toEqual({});
    expect(() => reasoningRequest('high', UNKNOWN_REASONING, 'openai')).toThrow();
  });
  const cases: [string, ThinkMode, Record<string, unknown>][] = [
    ['openrouter', 'high', { reasoning: { effort: 'high' } }],
    ['openrouter', 'none', { reasoning: { enabled: false } }],
    ['openai', 'high', { reasoning_effort: 'high' }],
    ['openai', 'none', { reasoning_effort: 'none' }],
    ['deepseek', 'max', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
    ['deepseek', 'none', { thinking: { type: 'disabled' } }],
  ];
  it.each(cases)('%s sends %s in its actual chat HTTP request', async (protocol, mode, expected) => {
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response('data: {"choices":[{"delta":{"reasoning_content":"thinking", "content":"answer"}}]}\n\ndata: [DONE]\n\n');
    }));
    const cap = documentedReasoning(protocol === 'openrouter' ? 'openai' : protocol, protocol === 'deepseek' ? 'deepseek-v4-pro' : 'gpt-5.4');
    const adapter = protocol === 'openrouter' ? new CustomAdapter('test', 'https://openrouter.ai/api/v1', 'openrouter') : protocol === 'deepseek' ? new DeepSeekAdapter('test') : new OpenAIAdapter('test');
    const events = [];
    for await (const event of adapter.stream({ model: 'unchanged-model', messages: [], webMode: 'off', thinkMode: mode, reasoning: cap })) events.push(event);
    expect(body).toMatchObject({ model: 'unchanged-model', ...expected });
    if (protocol === 'openrouter') {
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body.provider).toEqual({ require_parameters: true });
    }
    if (mode === 'none' && protocol === 'deepseek') expect(body).not.toHaveProperty('reasoning_effort');
    expect(events).toContainEqual({ type: 'delta', text: 'answer' });
    expect(events).toContainEqual({ type: 'thinking', text: 'thinking' });
  });
  it('applies the same effort when native search uses Responses', async () => {
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { body = JSON.parse(init.body); return new Response('data: [DONE]\n'); }));
    for await (const _ of new OpenAIAdapter('test').stream({ model: 'gpt-5.4', messages: [], thinkMode: 'xhigh', webMode: 'auto', reasoning: documentedReasoning('openai', 'gpt-5.4') })) { /* drain */ }
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
    expect(body.tools).toEqual([{ type: 'web_search' }]);
  });
});
