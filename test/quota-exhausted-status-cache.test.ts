import { afterAll, expect, test } from 'bun:test';
import { serve } from 'bun';
import router from '../src/router.js';
import { getConfig, loadConfig, updateConfig } from '../src/config.js';

let providerARequests = 0;
let providerBRequests = 0;

const providerAServer = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      providerARequests++;
      if (providerARequests === 1) {
        return Response.json({ error: { message: '0% quota left' } }, { status: 529 });
      }
      return Response.json({
        id: 'a-ok',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'a' }, finish_reason: 'stop' }]
      });
    }
    return new Response('Not Found', { status: 404 });
  }
});

const providerBServer = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      providerBRequests++;
      return Response.json({
        id: 'b-ok',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'b' }, finish_reason: 'stop' }]
      });
    }
    return new Response('Not Found', { status: 404 });
  }
});

afterAll(() => {
  providerAServer.stop(true);
  providerBServer.stop(true);
});

test('uses configured quota exhausted status cache TTL based on last request status', async () => {
  await loadConfig(true);
  const originalConfig = getConfig();
  const testConfig = structuredClone(originalConfig);

  testConfig.providers = {
    p1: {
      baseUrl: `http://127.0.0.1:${providerAServer.port}`,
      description: 'provider a',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m'],
      statusCodes: {
        quotaExhausted: [529]
      },
      quotaExhaustedCacheTTLSeconds: 1
    },
    p2: {
      baseUrl: `http://127.0.0.1:${providerBServer.port}`,
      description: 'provider b',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m']
    }
  };
  testConfig.combos = {
    test: {
      description: 'quota exhausted fallback chain',
      models: [
        { provider: 'p1', model: 'm' },
        { provider: 'p2', model: 'm' }
      ]
    }
  };

  providerARequests = 0;
  providerBRequests = 0;
  updateConfig(testConfig);

  try {
    const first = await router.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    expect(first.status).toBe(200);
    expect(providerARequests).toBe(1);
    expect(providerBRequests).toBe(1);

    const second = await router.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hello again' }]
      })
    });
    expect(second.status).toBe(200);
    expect(providerARequests).toBe(1);
    expect(providerBRequests).toBe(2);

    await Bun.sleep(1_200);

    const third = await router.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'after ttl' }]
      })
    });
    expect(third.status).toBe(200);
    expect(providerARequests).toBe(2);
  } finally {
    updateConfig(originalConfig);
  }
}, 60_000);
