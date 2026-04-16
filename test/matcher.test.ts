import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MatcherRegistry, runMatchers, type MatchContext } from '../src/matcher.js';

describe('Matcher Plugin System', () => {
  let tempDir: string;

  beforeEach(() => {
    MatcherRegistry.resetInstance();
    tempDir = mkdtempSync(join(tmpdir(), 'matcher-test-'));
  });

  afterEach(() => {
    MatcherRegistry.resetInstance();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeMatcherFile(fileName: string, content: string): string {
    const filePath = join(tempDir, fileName);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /** Helper: set rules directly on the registry (bypasses config). */
  function setRules(
    rules: Array<{ file: string; name: string; fn: (ctx: MatchContext) => boolean | Promise<boolean> }>,
  ) {
    const registry = MatcherRegistry.getInstance();
    // @ts-expect-error - accessing private for test
    registry.rules = rules;
  }

  const baseCtx: MatchContext = {
    body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] },
    headers: { 'user-agent': 'test-client' },
    route: '/v1/chat/completions',
    wireFormat: 'openai',
    requestedModel: 'gpt-4',
  };

  const anthropicCtx: MatchContext = {
    ...baseCtx,
    route: '/v1/messages',
    wireFormat: 'anthropic',
  };

  // ── Built-in matchers ───────────────────────────────────────────────

  describe('built-in matchers', () => {
    test('openai matcher fires for openai wireFormat', async () => {
      const result = await runMatchers(baseCtx);
      expect(result).toContain('openai');
      expect(result).not.toContain('anthropic');
    });

    test('anthropic matcher fires for anthropic wireFormat', async () => {
      const result = await runMatchers(anthropicCtx);
      expect(result).toContain('anthropic');
      expect(result).not.toContain('openai');
    });

    test('user rule named "anthropic" overrides the built-in', async () => {
      setRules([{
        file: 'custom.ts',
        name: 'anthropic',
        fn: (ctx: MatchContext) => ctx.body.model === 'custom-trigger',
      }]);

      // Built-in would match (wireFormat is anthropic), but user override replaces it
      const result = await runMatchers({
        ...anthropicCtx,
        body: { model: 'other', messages: [] },
      });
      expect(result).not.toContain('anthropic');
    });

    test('user override "anthropic" can still match with custom logic', async () => {
      setRules([{
        file: 'custom.ts',
        name: 'anthropic',
        fn: (ctx: MatchContext) => ctx.body.model === 'custom-trigger',
      }]);

      const result = await runMatchers({
        ...anthropicCtx,
        body: { model: 'custom-trigger', messages: [] },
      });
      expect(result).toContain('anthropic');
    });
  });

  // ── Predicate evaluation ──────────────────────────────────────────────

  describe('runMatchers — predicate evaluation', () => {
    test('returns only built-in matchers when no user rules configured', async () => {
      const result = await runMatchers(baseCtx);
      expect(result).toEqual(new Set(['openai']));
    });

    test('sync matcher returning true adds name to matched set', async () => {
      setRules([{
        file: 'sync.ts',
        name: 'is-gpt4',
        fn: () => true,
      }]);

      const result = await runMatchers({ ...baseCtx, requestedModel: 'gpt-4' });
      expect(result).toContain('is-gpt4');
      expect(result).toContain('openai'); // built-in still fires
    });

    test('sync matcher returning false does not match', async () => {
      setRules([{
        file: 'sync.ts',
        name: 'never',
        fn: () => false,
      }]);

      const result = await runMatchers(baseCtx);
      expect(result).not.toContain('never');
      expect(result).toContain('openai'); // built-in still fires
    });

    test('async matcher returning true adds name to matched set', async () => {
      setRules([{
        file: 'async.ts',
        name: 'async-check',
        fn: async (ctx: MatchContext) => {
          await new Promise(r => setTimeout(r, 1));
          return ctx.requestedModel === 'gpt-4';
        },
      }]);

      const result = await runMatchers(baseCtx);
      expect(result).toContain('async-check');
      expect(result).toContain('openai');
    });

    test('matcher that throws is skipped — fail-open', async () => {
      setRules([{
        file: 'throws.ts',
        name: 'explodes',
        fn: () => { throw new Error('boom'); },
      }]);

      const result = await runMatchers(baseCtx);
      expect(result).not.toContain('explodes');
      expect(result).toContain('openai');
    });

    test('multiple matchers evaluate independently — all true names collected', async () => {
      setRules([
        { file: 'a.ts', name: 'alpha', fn: () => true },
        { file: 'b.ts', name: 'beta', fn: () => true },
        { file: 'c.ts', name: 'gamma', fn: () => false },
      ]);

      const result = await runMatchers(baseCtx);
      expect(result).toContain('alpha');
      expect(result).toContain('beta');
      expect(result).not.toContain('gamma');
      expect(result).toContain('openai');
    });

    test('matcher returning truthy non-boolean (1) is not true — skipped', async () => {
      setRules([{
        file: 'truthy.ts',
        name: 'truthy-one',
        fn: () => 1 as unknown as boolean,
      }]);

      const result = await runMatchers(baseCtx);
      expect(result).not.toContain('truthy-one');
    });
  });

  // ── Registry ──────────────────────────────────────────────────────────

  describe('MatcherRegistry', () => {
    test('loadAll skips malformed files, loads valid ones', async () => {
      const matchersDir = join(tempDir, 'matchers');
      mkdirSync(matchersDir, { recursive: true });

      writeFileSync(
        join(matchersDir, 'a-valid.ts'),
        `export default (ctx: any) => ctx.requestedModel === 'gpt-4';`,
      );
      writeFileSync(
        join(matchersDir, 'b-broken.ts'),
        `this is not valid typescript!!! @#$%^&*(`,
      );

      const registry = MatcherRegistry.getInstance();
      await registry.loadFromRules([
        { file: join(matchersDir, 'a-valid.ts'), name: 'valid' },
        { file: join(matchersDir, 'b-broken.ts'), name: 'broken' },
      ]);

      const rules = registry.getRules();
      expect(rules.find(r => r.name === 'valid')).toBeDefined();
      expect(rules.find(r => r.name === 'broken')).toBeUndefined();
      // built-ins are also present
      expect(rules.find(r => r.name === 'anthropic')).toBeDefined();
      expect(rules.find(r => r.name === 'openai')).toBeDefined();
    });

    test('loadAll skips files with no default export function', async () => {
      const matchersDir = join(tempDir, 'matchers');
      mkdirSync(matchersDir, { recursive: true });

      writeFileSync(
        join(matchersDir, 'no-export.ts'),
        `export const something = "not a function";`,
      );

      const registry = MatcherRegistry.getInstance();
      await registry.loadFromRules([
        { file: join(matchersDir, 'no-export.ts'), name: 'no-fn' },
      ]);

      const rules = registry.getRules();
      expect(rules.find(r => r.name === 'no-fn')).toBeUndefined();
      // built-ins still present
      expect(rules.length).toBe(2);
    });

    test('config reload picks up new rule file', async () => {
      const matchersDir = join(tempDir, 'matchers');
      mkdirSync(matchersDir, { recursive: true });

      writeFileSync(
        join(matchersDir, 'first.ts'),
        `export default () => true;`,
      );

      const registry = MatcherRegistry.getInstance();
      await registry.loadFromRules([
        { file: join(matchersDir, 'first.ts'), name: 'first' },
      ]);

      expect(registry.getRules().find(r => r.name === 'first')).toBeDefined();
    });
  });

  // ── Boundary validation ────────────────────────────────────────────────

  describe('boundary validation', () => {
    test('rejects matcher returning non-boolean string', async () => {
      const matchersDir = join(tempDir, 'matchers');
      mkdirSync(matchersDir, { recursive: true });

      writeFileSync(
        join(matchersDir, 'string-bool.ts'),
        `export default async () => "yes";`,
      );

      const registry = MatcherRegistry.getInstance();
      await registry.loadFromRules([
        { file: join(matchersDir, 'string-bool.ts'), name: 'string-bool' },
      ]);

      const rule = registry.getRules().find(r => r.name === 'string-bool');
      expect(rule).toBeDefined();
      await expect(rule!.fn(baseCtx)).rejects.toThrow();
    });

    test('rejects matcher returning number', async () => {
      const matchersDir = join(tempDir, 'matchers');
      mkdirSync(matchersDir, { recursive: true });

      writeFileSync(
        join(matchersDir, 'number-bool.ts'),
        `export default async () => 1;`,
      );

      const registry = MatcherRegistry.getInstance();
      await registry.loadFromRules([
        { file: join(matchersDir, 'number-bool.ts'), name: 'number-bool' },
      ]);

      const rule = registry.getRules().find(r => r.name === 'number-bool');
      expect(rule).toBeDefined();
      await expect(rule!.fn(baseCtx)).rejects.toThrow();
    });

    test('rejects matcher returning undefined', async () => {
      const matchersDir = join(tempDir, 'matchers');
      mkdirSync(matchersDir, { recursive: true });

      writeFileSync(
        join(matchersDir, 'no-return.ts'),
        `export default async () => { /* no return */ };`,
      );

      const registry = MatcherRegistry.getInstance();
      await registry.loadFromRules([
        { file: join(matchersDir, 'no-return.ts'), name: 'no-return' },
      ]);

      const rule = registry.getRules().find(r => r.name === 'no-return');
      expect(rule).toBeDefined();
      await expect(rule!.fn(baseCtx)).rejects.toThrow();
    });

    test('accepts matcher returning true', async () => {
      const matchersDir = join(tempDir, 'matchers');
      mkdirSync(matchersDir, { recursive: true });

      writeFileSync(
        join(matchersDir, 'valid.ts'),
        `export default async () => true;`,
      );

      const registry = MatcherRegistry.getInstance();
      await registry.loadFromRules([
        { file: join(matchersDir, 'valid.ts'), name: 'valid' },
      ]);

      const rule = registry.getRules().find(r => r.name === 'valid');
      expect(rule).toBeDefined();
      expect(await rule!.fn(baseCtx)).toBe(true);
    });
  });

  // ── MatchContext fields ──────────────────────────────────────────────

  describe('MatchContext', () => {
    test('matcher receives correct route for Anthropic format', async () => {
      let capturedRoute: string | null = null;

      setRules([{
        file: 'route-check.ts',
        name: 'route-check',
        fn: (ctx: MatchContext) => {
          capturedRoute = ctx.route;
          return false;
        },
      }]);

      await runMatchers({ ...anthropicCtx });

      expect(capturedRoute).toBe('/v1/messages');
    });

    test('matcher can inspect headers to route based on user-agent', async () => {
      setRules([{
        file: 'ua-route.ts',
        name: 'is-claude-code',
        fn: (ctx: MatchContext) => ctx.headers['x-client'] === 'claude-code',
      }]);

      const result = await runMatchers({
        ...baseCtx,
        headers: { 'x-client': 'claude-code' },
      });
      expect(result).toContain('is-claude-code');
      expect(result).toContain('openai');
    });

    test('matcher can inspect body to route based on thinking config', async () => {
      setRules([{
        file: 'thinking.ts',
        name: 'has-thinking',
        fn: (ctx: MatchContext) => ctx.body.thinking !== undefined,
      }]);

      const withThinking = await runMatchers({
        ...baseCtx,
        body: { ...baseCtx.body, thinking: { type: 'enabled', budget_tokens: 10000 } },
      });
      expect(withThinking).toContain('has-thinking');
      expect(withThinking).toContain('openai');
    });
  });
});
