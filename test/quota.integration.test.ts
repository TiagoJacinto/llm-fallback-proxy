import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { QuotaManager } from '../src/quota.js';
import type { QuotaConfig } from '../src/config.js';

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';
let remaining = 99.5;

describe('QuotaManager (integration)', () => {
  let quotaManager: QuotaManager;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/usage/agy') {
          const duration = 30 * 24 * 60 * 60;
          const reset = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
          return Response.json({ remaining, duration, reset });
        }
        if (url.pathname === '/api/usage/agy/set') {
          remaining = Number(url.searchParams.get('r') ?? '0');
          return Response.json({ remaining });
        }
        return new Response('Not Found', { status: 404 });
      }
    });

    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    remaining = 99.5;
    quotaManager = QuotaManager.getInstance();
    quotaManager.clearCache();
  });

  test('HTTP usageServer + timestamp mode allows when quota is healthy', async () => {
    const config: QuotaConfig = {
      usageServer: { type: 'http', url: `${baseUrl}/api/usage/agy` },
      quotaRemaining: { path: '$.remaining', overdraftPercent: 2 },
      reset: { mode: 'timestamp', path: '$.reset' },
      cacheTTLSeconds: 0
    };

    const isAllowed = await quotaManager.checkPacing('int-http-timestamp', config);
    expect(isAllowed).toBe(true);
  });

  test('rolling-window with seeded cache uses persisted start timestamp', async () => {
    const config: QuotaConfig = {
      usageServer: { type: 'http', url: `${baseUrl}/api/usage/agy` },
      quotaRemaining: { path: '$.remaining', overdraftPercent: 2 },
      reset: { mode: 'rolling-window', durationPath: '$.duration' },
      cacheTTLSeconds: 60
    };

    const halfDuration = 15 * 24 * 60 * 60;
    const windowStart = new Date(Date.now() - halfDuration * 1000).toISOString();
    quotaManager.seedCache('int-rolling-cached', 50, windowStart, 30 * 24 * 60 * 60);

    const isAllowed = await quotaManager.checkPacing('int-rolling-cached', config);
    expect(isAllowed).toBe(true);
  });

  test('stdio usageServer command path is parsed correctly', async () => {
    const config: QuotaConfig = {
      usageServer: {
        type: 'stdio',
        command: 'echo',
        args: ['{"remaining": 80, "duration": 2592000}'],
        env: {}
      },
      quotaRemaining: { path: '$.remaining', overdraftPercent: 2 },
      reset: { mode: 'rolling-window', durationPath: '$.duration' },
      cacheTTLSeconds: 0
    };

    const isAllowed = await quotaManager.checkPacing('int-stdio', config);
    expect(isAllowed).toBe(true);
  });
});
