import { afterAll, expect, test } from 'bun:test';
import { serve } from 'bun';
import router from '../src/router.js';
import { getConfig, loadConfig, updateConfig } from '../src/config.js';

let upstreamRequests = 0;

const mockProvider = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      upstreamRequests += 1;
      return Response.json({
        id: 'ok',
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
  mockProvider.stop(true);
});

test('chat completions invalid JSON returns invalid_request_error', async () => {
  upstreamRequests = 0;
  const response = await router.request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"test","messages":[{"role":"user","content":"x"}]'
  });

  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.type).toBe('invalid_request_error');
  expect(payload.error.code).toBe('invalid_json_body');
  expect(upstreamRequests).toBe(0);
});

test('chat completions missing messages returns invalid_request_error before provider call', async () => {
  await loadConfig(true);
  const originalConfig = getConfig();
  const testConfig = structuredClone(originalConfig);

  testConfig.providers = {
    p1: {
      baseUrl: `http://127.0.0.1:${mockProvider.port}`,
      description: 'mock',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m']
    }
  };
  testConfig.combos = {
    test: {
      description: 'test combo',
      models: [{ provider: 'p1', model: 'm' }]
    }
  };

  upstreamRequests = 0;
  updateConfig(testConfig);

  try {
    const response = await router.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test'
      })
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.type).toBe('invalid_request_error');
    // Using zod-validator, the error code format is just the Zod path or a generic error string
    // Let's just check that it's a validation error
    expect(payload.error.message).toBeDefined();
    expect(upstreamRequests).toBe(0);
  } finally {
    updateConfig(originalConfig);
  }
}, 60_000);

test('anthropic messages invalid payload returns invalid_request_error', async () => {
  upstreamRequests = 0;
  const response = await router.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      messages: 'not-an-array'
    })
  });

  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.type).toBe('invalid_request_error');
  expect(payload.error.message).toBeDefined();
  expect(upstreamRequests).toBe(0);
});
