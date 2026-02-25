import { QuotaManager } from '../src/quota.js';
import type { QuotaConfig } from '../src/config.js';
import { expect, test, describe, beforeEach, afterEach } from 'bun:test';

const ORIGINAL_FETCH = globalThis.fetch;

describe('QuotaManager (unit)', () => {
  let quotaManager: QuotaManager;

  beforeEach(() => {
    quotaManager = QuotaManager.getInstance();
    quotaManager.clearCache();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  describe('Timestamp mode', () => {
    test('allows request when quotaRemaining >= pacing threshold', async () => {
      const config: QuotaConfig = {
        usageServer: { type: 'http', url: 'http://quota.local/usage' },
        quotaRemaining: { path: '$.remaining', overdraftPercent: 2 },
        reset: { mode: 'timestamp', path: '$.reset' },
        cacheTTLSeconds: 0
      };

      globalThis.fetch = async () => Response.json({
        remaining: 60,
        reset: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
      });

      const isAllowed = await quotaManager.checkPacing('test-http-timestamp-allow', config);
      expect(isAllowed).toBe(true);
    });

    test('blocks request when quotaRemaining < pacing threshold', async () => {
      const config: QuotaConfig = {
        usageServer: { type: 'http', url: 'http://quota.local/usage' },
        quotaRemaining: { path: '$.remaining', overdraftPercent: 2 },
        reset: { mode: 'timestamp', path: '$.reset' },
        cacheTTLSeconds: 0
      };

      globalThis.fetch = async () => Response.json({
        remaining: 10,
        reset: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
      });

      const isAllowed = await quotaManager.checkPacing('test-http-timestamp-block', config);
      expect(isAllowed).toBe(false);
    });
  });

  describe('Rolling-window mode', () => {
    test('calculates time remaining from seeded rolling window timestamp', async () => {
      const config: QuotaConfig = {
        usageServer: { type: 'http', url: 'http://quota.local/usage' },
        quotaRemaining: { path: '$.remaining', overdraftPercent: 2 },
        reset: { mode: 'rolling-window', durationPath: '$.duration' },
        cacheTTLSeconds: 60
      };

      const halfDurationSec = 15 * 24 * 60 * 60;
      const windowStart = new Date(Date.now() - halfDurationSec * 1000).toISOString();
      quotaManager.seedCache('test-rolling-cached', 50, windowStart, 30 * 24 * 60 * 60);

      const isAllowed = await quotaManager.checkPacing('test-rolling-cached', config);
      expect(isAllowed).toBe(true);
    });
  });

  describe('Degraded mode', () => {
    test('fails closed on cold start when quota endpoint is unreachable', async () => {
      const config: QuotaConfig = {
        usageServer: { type: 'http', url: 'http://quota.local/unreachable' },
        quotaRemaining: { path: '$.remaining', overdraftPercent: 5 },
        reset: { mode: 'timestamp', path: '$.reset' },
        cacheTTLSeconds: 0
      };

      globalThis.fetch = async () => {
        throw new Error('network down');
      };

      const isAllowed = await quotaManager.checkPacing('test-degraded-cold-start', config);
      expect(isAllowed).toBe(false);
    });

    test('uses stale cache with overdraft when endpoint fails', async () => {
      const config: QuotaConfig = {
        usageServer: { type: 'http', url: 'http://quota.local/unreachable' },
        quotaRemaining: { path: '$.remaining', overdraftPercent: 5 },
        reset: { mode: 'timestamp', path: '$.reset' },
        cacheTTLSeconds: 0
      };

      const resetInFifteenDays = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
      quotaManager.seedCache('test-degraded-stale-cache', 48, resetInFifteenDays);

      globalThis.fetch = async () => {
        throw new Error('network down');
      };

      const isAllowed = await quotaManager.checkPacing('test-degraded-stale-cache', config);
      expect(isAllowed).toBe(true);
    });
  });
});
