import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RouterRegistry, type RouterFunction, type RouterCandidate } from '../src/router-registry.js';
import type { MatchContext } from '../src/router-registry.js';

describe('RouterRegistry', () => {
  let tempDir: string;

  beforeEach(() => {
    RouterRegistry.resetInstance();
    tempDir = mkdtempSync(join(tmpdir(), 'router-test-'));
  });

  afterEach(() => {
    RouterRegistry.resetInstance();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRouterFile(fileName: string, content: string): void {
    writeFileSync(join(tempDir, fileName), content, 'utf-8');
  }

  const baseCtx: MatchContext = {
    body: { model: 'smart-route', messages: [{ role: 'user', content: 'hello' }] },
    headers: {},
    route: '/v1/chat/completions',
    wireFormat: 'openai',
    requestedModel: 'smart-route',
  };

  // ── Loading ────────────────────────────────────────────────────────────

  describe('load', () => {
    test('loads a valid router TS file', async () => {
      writeRouterFile('router.ts', `
        export default (ctx) => [
          { model: 'gpt-4o', provider: 'openai' },
          { model: 'claude-3-5-sonnet', provider: 'anthropic' },
        ];
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router.ts', tempDir);

      expect(registry.getRouter()).not.toBeNull();
      const result = await registry.getRouter()!(baseCtx);
      expect(result).toEqual([
        { model: 'gpt-4o', provider: 'openai' },
        { model: 'claude-3-5-sonnet', provider: 'anthropic' },
      ]);
    });

    test('returns null for file with no default export', async () => {
      writeRouterFile('bad.ts', `export const something = "not a function";`);

      const registry = RouterRegistry.getInstance();
      await registry.load('bad.ts', tempDir);

      expect(registry.getRouter()).toBeNull();
    });

    test('returns null for file that does not exist', async () => {
      const registry = RouterRegistry.getInstance();
      await registry.load('nonexistent.ts', tempDir);

      expect(registry.getRouter()).toBeNull();
    });
  });

  // ── Router execution ───────────────────────────────────────────────────

  describe('router execution', () => {
    test('router returns string-only candidates', async () => {
      writeRouterFile('router.ts', `
        export default (ctx) => ['gpt-4o', 'claude-3-5-sonnet', 'gemini-pro'];
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router.ts', tempDir);

      const result = await registry.getRouter()!(baseCtx);
      expect(result).toEqual(['gpt-4o', 'claude-3-5-sonnet', 'gemini-pro']);
    });

    test('router returns object candidates with provider', async () => {
      writeRouterFile('router.ts', `
        export default (ctx) => [
          { model: 'gpt-4o', provider: 'openai' },
          { model: 'claude-3-5-sonnet', provider: 'anthropic' },
        ];
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router.ts', tempDir);

      const result = await registry.getRouter()!(baseCtx);
      expect(result).toEqual([
        { model: 'gpt-4o', provider: 'openai' },
        { model: 'claude-3-5-sonnet', provider: 'anthropic' },
      ]);
    });

    test('router returns mixed string and object candidates', async () => {
      writeRouterFile('router.ts', `
        export default (ctx) => [
          'model1',
          'model2',
          { model: 'model3', provider: 'provider1' },
          { model: 'model4' },
        ];
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router.ts', tempDir);

      const result = await registry.getRouter()!(baseCtx);
      expect(result).toEqual([
        'model1',
        'model2',
        { model: 'model3', provider: 'provider1' },
        { model: 'model4' },
      ]);
    });

    test('router can use async logic', async () => {
      writeRouterFile('router.ts', `
        export default async (ctx) => {
          await new Promise(r => setTimeout(r, 1));
          return [{ model: 'gpt-4o', provider: 'openai' }];
        };
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router.ts', tempDir);

      const result = await registry.getRouter()!(baseCtx);
      expect(result).toEqual([{ model: 'gpt-4o', provider: 'openai' }]);
    });

    test('router can inspect MatchContext fields', async () => {
      writeRouterFile('router.ts', `
        export default (ctx) => {
          if (ctx.wireFormat === 'anthropic') {
            return [{ model: 'claude-sonnet-4-20250514', provider: 'anthropic' }];
          }
          return [{ model: 'gpt-4o', provider: 'openai' }];
        };
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router.ts', tempDir);

      const openaiResult = await registry.getRouter()!(baseCtx);
      expect(openaiResult).toEqual([{ model: 'gpt-4o', provider: 'openai' }]);

      const anthropicCtx: MatchContext = {
        ...baseCtx,
        route: '/v1/messages',
        wireFormat: 'anthropic',
      };
      const anthropicResult = await registry.getRouter()!(anthropicCtx);
      expect(anthropicResult).toEqual([{ model: 'claude-sonnet-4-20250514', provider: 'anthropic' }]);
    });
  });

  // ── Reload ─────────────────────────────────────────────────────────────

  describe('reloadIfNeeded', () => {
    test('skips reload when file path unchanged', async () => {
      writeRouterFile('router.ts', `
        export default () => [{ model: 'v1', provider: 'a' }];
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router.ts', tempDir);

      // Same path — should skip
      await registry.reloadIfNeeded('router.ts', tempDir);

      const result = await registry.getRouter()!(baseCtx);
      expect(result).toEqual([{ model: 'v1', provider: 'a' }]);
    });

    test('reloads when file path changes', async () => {
      writeRouterFile('router-v1.ts', `
        export default () => [{ model: 'v1', provider: 'a' }];
      `);
      writeRouterFile('router-v2.ts', `
        export default () => [{ model: 'v2', provider: 'b' }];
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router-v1.ts', tempDir);

      const v1 = await registry.getRouter()!(baseCtx);
      expect(v1).toEqual([{ model: 'v1', provider: 'a' }]);

      await registry.reloadIfNeeded('router-v2.ts', tempDir);

      const v2 = await registry.getRouter()!(baseCtx);
      expect(v2).toEqual([{ model: 'v2', provider: 'b' }]);
    });

    test('keeps last-known-good on reload failure', async () => {
      writeRouterFile('good.ts', `
        export default () => [{ model: 'good', provider: 'a' }];
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('good.ts', tempDir);

      // Reload with non-existent file
      await registry.reloadIfNeeded('nonexistent.ts', tempDir);

      // Should still have the good router
      const result = await registry.getRouter()!(baseCtx);
      expect(result).toEqual([{ model: 'good', provider: 'a' }]);
    });

    test('clears router when newRouterFile is null', async () => {
      writeRouterFile('router.ts', `
        export default () => [{ model: 'v1', provider: 'a' }];
      `);

      const registry = RouterRegistry.getInstance();
      await registry.load('router.ts', tempDir);
      expect(registry.getRouter()).not.toBeNull();

      await registry.reloadIfNeeded(null, tempDir);

      expect(registry.getRouter()).toBeNull();
    });
  });

  // ── Singleton ──────────────────────────────────────────────────────────

  describe('singleton', () => {
    test('getInstance returns same instance', () => {
      const a = RouterRegistry.getInstance();
      const b = RouterRegistry.getInstance();
      expect(a).toBe(b);
    });

    test('resetInstance creates fresh instance', () => {
      const first = RouterRegistry.getInstance();
      RouterRegistry.resetInstance();
      const second = RouterRegistry.getInstance();
      expect(first).not.toBe(second);
    });
  });
});
