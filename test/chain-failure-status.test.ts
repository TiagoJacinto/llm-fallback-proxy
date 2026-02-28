import { afterAll, expect, test } from 'bun:test';
import { serve } from 'bun';
import router from '../src/router.js';
import { loadConfig, getConfig, updateConfig } from '../src/config.js';

let failProviderRequests = 0;
let slowProviderRequests = 0;
let fallbackProviderRequests = 0;

const failServer = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      failProviderRequests += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: 'upstream failure'
          }
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    return new Response('Not Found', { status: 404 });
  }
});

const slowServer = serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      slowProviderRequests += 1;
      await Bun.sleep(150);
      return new Response(
        JSON.stringify({
          id: 'slow',
          object: 'chat.completion',
          created: Date.now(),
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }]
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not Found', { status: 404 });
  }
});

const fallbackServer = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      fallbackProviderRequests += 1;
      return Response.json({
        id: 'fallback-ok',
        object: 'chat.completion',
        created: Date.now(),
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      });
    }
    return new Response('Not Found', { status: 404 });
  }
});

afterAll(() => {
  failServer.stop(true);
  slowServer.stop(true);
  fallbackServer.stop(true);
});

test('exhausts fallback chain and returns 422 all_models_failed', async () => {
  await loadConfig(true);
  const originalConfig = getConfig();
  const testConfig = structuredClone(originalConfig);

  testConfig.providers = {
    p1: {
      baseUrl: `http://127.0.0.1:${failServer.port}`,
      description: 'failing provider 1',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m']
    },
    p2: {
      baseUrl: `http://127.0.0.1:${failServer.port}`,
      description: 'failing provider 2',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m']
    }
  };

  testConfig.combos = {
    test: {
      description: 'all fail',
      models: [
        { provider: 'p1', model: 'm' },
        { provider: 'p2', model: 'm' }
      ]
    }
  };

  failProviderRequests = 0;
  updateConfig(testConfig);

  try {
    const res = await router.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error?.code).toBe('all_models_failed');
    expect(failProviderRequests).toBe(2);
  } finally {
    updateConfig(originalConfig);
  }
}, 60_000);

test('chain timeout returns 504 without trying fallback once deadline is exhausted', async () => {
  await loadConfig(true);
  const originalConfig = getConfig();
  const originalChainMaxDurationMs = process.env.CHAIN_MAX_DURATION_MS;
  const testConfig = structuredClone(originalConfig);

  process.env.CHAIN_MAX_DURATION_MS = '60';

  testConfig.providers = {
    p1: {
      baseUrl: `http://127.0.0.1:${slowServer.port}`,
      description: 'slow provider',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m']
    },
    p2: {
      baseUrl: `http://127.0.0.1:${fallbackServer.port}`,
      description: 'fast fallback',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m']
    }
  };

  testConfig.combos = {
    test: {
      description: 'slow then fallback',
      models: [
        { provider: 'p1', model: 'm' },
        { provider: 'p2', model: 'm' }
      ]
    }
  };

  slowProviderRequests = 0;
  fallbackProviderRequests = 0;
  updateConfig(testConfig);

  try {
    const res = await router.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    const body = await res.json();

    expect(res.status).toBe(504);
    expect(body.error?.code).toBe('chain_timeout');
    expect(slowProviderRequests).toBe(1);
    expect(fallbackProviderRequests).toBe(0);
  } finally {
    if (originalChainMaxDurationMs === undefined) {
      delete process.env.CHAIN_MAX_DURATION_MS;
    } else {
      process.env.CHAIN_MAX_DURATION_MS = originalChainMaxDurationMs;
    }
    updateConfig(originalConfig);
  }
}, 60_000);
