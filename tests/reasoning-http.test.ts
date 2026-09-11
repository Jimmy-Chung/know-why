import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';

let app: Hono;
let repo: typeof import('../src/server/repo.js');
let db: typeof import('../src/server/db.js');
const mockBase = 'https://fixture.invalid/v1';
const dataDir = mkdtempSync(join(tmpdir(), 'kk-reasoning-http-'));
async function call(path: string, method = 'GET', body?: any) {
  const response = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  vi.stubEnv('KNOW_KNOW_DATA_DIR', dataDir);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/models')) return Response.json({ data: [
      { id: 'adjustable', reasoning: { supported_efforts: ['high', 'low'], mandatory: true } },
      { id: 'plain', supported_parameters: [] },
    ] });
    return Response.json({ choices: [{ message: { content: '测试会话' } }] });
  }));
  ({ app } = await import('../src/server/index.js'));
  repo = await import('../src/server/repo.js');
  db = await import('../src/server/db.js');
});
afterAll(() => {
  db.closeDb();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('conversation settings HTTP contract', () => {
  it('discovers capability, persists settings, resets across model/provider changes, validates and locks', async () => {
    const p = (await call('/api/providers', 'POST', { type: 'openrouter', name: 'fixture', default_model: 'adjustable', api_base: mockBase, is_default: true })).body;
    const d = (await call('/api/conversations', 'POST')).body;
    const path = `/api/conversations/${d.conversation.id}`;
    expect(d.conversation.think_mode).toBe('default');
    const catalog = await call(`/api/providers/${p.id}/models?model=adjustable`);
    expect(catalog.body.reasoning.efforts).toEqual(['low', 'high']);
    expect((await call(path, 'PATCH', { web_mode: 'off', think_mode: 'high' })).body).toMatchObject({ web_mode: 'off', think_mode: 'high' });
    expect((await call(path)).body.conversation.think_mode).toBe('high');
    expect((await call(path, 'PATCH', { think_mode: 'none' })).status).toBe(400);
    expect((await call(path, 'PATCH', { web_mode: 'bad' })).status).toBe(400);
    expect((await call(path, 'PATCH', { think_mode: 'xhigh' })).status).toBe(400);
    expect((await call(path, 'PATCH', { model: 'plain' })).body.think_mode).toBe('default');
    expect((await call(path, 'PATCH', { think_mode: 'high' })).status).toBe(400);
    const deepseek = (await call('/api/providers', 'POST', { type: 'deepseek', name: 'fixture ds', default_model: 'deepseek-v4-pro', api_base: mockBase })).body;
    const switched = await call(path, 'PATCH', { provider_id: deepseek.id });
    expect(switched.body).toMatchObject({ provider_id: deepseek.id, model: 'deepseek-v4-pro', think_mode: 'default' });
    expect((await call(path, 'PATCH', { think_mode: 'max' })).body.think_mode).toBe('max');
    const queued = await call(`/api/cards/${d.mainCard.id}/messages`, 'POST', { content: 'fixture message' });
    expect(queued.status).toBe(200);
    expect(queued.body.run.think_mode).toBe('max');
    expect((await call(path, 'PATCH', { model: 'plain' })).status).toBe(409);
    expect((await call(path, 'PATCH', { provider_id: p.id })).status).toBe(409);
    expect((await call(path, 'PATCH', { think_mode: 'low', web_mode: 'force' })).body).toMatchObject({ think_mode: 'low', web_mode: 'force' });
    expect(repo.runs.get(queued.body.run.id)?.think_mode).toBe('max');
  });
});
