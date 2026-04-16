// ABOUTME: Matcher plugin system — user-defined TS predicates evaluated before combo lookup
// ABOUTME: Matchers return boolean; combos reference matcher names to activate

import { resolve, isAbsolute } from 'path';
import { z } from 'zod';
import { logger } from './logger.js';
import { getConfig, getConfigPath } from './config.js';

// ── Types ──────────────────────────────────────────────────────────────

/** Everything a matcher or router can inspect about an incoming request. */
export interface MatchContext {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  route: '/v1/chat/completions' | '/v1/messages';
  wireFormat: 'anthropic' | 'openai';
  requestedModel: string;
}

/** Signature user matcher files must export as default. */
export type MatcherFunction = (
  ctx: MatchContext,
) => boolean | Promise<boolean>;

// ── Schemas for boundary validation ─────────────────────────────────────

/** Zod schema for matcher function input/output.
 * implementAsync() awaits the user function before output validation,
 * so output is just z.boolean() — no need for z.promise().
 */
const MatcherFunctionSchema = z.function({
  input: [z.custom<MatchContext>()],
  output: z.boolean(),
});

/** Validates the module has a default export that is a function.
 * We do NOT use MatcherFunctionSchema here because z.function().parse()
 * wraps the function in a sync validator, destroying async behavior.
 * We use implementAsync() directly on the raw export instead.
 */
const MatcherModuleSchema = z.object({ default: z.function() });

// ── Matcher file loader ────────────────────────────────────────────────

/**
 * Load a matcher function from a user TS file.
 *
 * Bun caches by URL, so we append `?t=Date.now()` to force a fresh load.
 * Validates the module has a default function export, then wraps it with
 * Zod runtime input/output validation via implementAsync().
 * Returns null on failure (fail-open).
 */
async function loadMatcherFile(
  filePath: string,
): Promise<MatcherFunction | null> {
  try {
    const url = `file://${filePath}?t=${Date.now()}`;
    const parsed = MatcherModuleSchema.safeParse(await import(url));

    if (!parsed.success) {
      logger.warn('Matcher file has no default export function, skipping', {
        file: filePath,
      });
      return null;
    }

    // Cast through unknown: module schema only verifies "is a function";
    // implementAsync() provides the actual input/output runtime validation.
    const fn = MatcherFunctionSchema.implementAsync(
      parsed.data.default as unknown as MatcherFunction,
    );
    logger.debug('Matcher file loaded', { file: filePath });
    return fn;
  } catch (error) {
    logger.warn('Matcher file failed to load, skipping', {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ── Built-in matchers ──────────────────────────────────────────────────

/** Default matcher predicates — always available, overridable by user rules. */
const BUILTIN_MATCHERS: Record<string, MatcherFunction> = {
  anthropic: (ctx: MatchContext) => ctx.wireFormat === 'anthropic',
  openai: (ctx: MatchContext) => ctx.wireFormat === 'openai',
};

// ── Internal types ─────────────────────────────────────────────────────

interface LoadedRule {
  file: string;
  name: string;
  fn: MatcherFunction;
}

// ── Registry ───────────────────────────────────────────────────────────

export class MatcherRegistry {
  private static instance: MatcherRegistry | null = null;
  private rules: LoadedRule[] = [];

  private constructor() {}

  static getInstance(): MatcherRegistry {
    if (!MatcherRegistry.instance) {
      MatcherRegistry.instance = new MatcherRegistry();
    }
    return MatcherRegistry.instance;
  }

  /** Reset singleton — tests only. */
  static resetInstance(): void {
    MatcherRegistry.instance = null;
  }

  /** Load all matcher rules from config. Called at startup and on config reload. */
  async loadAll(): Promise<void> {
    let config: ReturnType<typeof getConfig>;
    try {
      config = getConfig();
    } catch {
      // Config not loaded yet
      this.rules = [];
      return;
    }

    const matchersConfig = config.matchers;
    if (!matchersConfig?.rules?.length) {
      this.rules = [];
      logger.debug('No matcher rules configured');
      return;
    }

    const configDir = new URL('.', getConfigPath()).pathname;
    await this.loadRules(matchersConfig.rules, configDir);
  }

  /** Load from explicit rule descriptors — used by tests and programmatic callers. */
  async loadFromRules(ruleDefs: Array<{ file: string; name: string }>): Promise<void> {
    await this.loadRules(ruleDefs, process.cwd());
  }

  /** Initialize — call once at startup. */
  async init(): Promise<void> {
    await this.loadAll();
  }

  /** Get current rules — user rules + built-ins (built-ins skipped when overridden by name). */
  getRules(): readonly LoadedRule[] {
    const userNames = new Set(this.rules.map((r) => r.name));
    const builtinRules: LoadedRule[] = Object.entries(BUILTIN_MATCHERS)
      .filter(([name]) => !userNames.has(name))
      .map(([name, fn]) => ({ file: '<builtin>', name, fn }));
    return [...this.rules, ...builtinRules];
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async loadRules(
    ruleDefs: ReadonlyArray<{ file: string; name: string }>,
    baseDir: string,
  ): Promise<void> {
    const loaded: LoadedRule[] = [];
    for (const def of ruleDefs) {
      const absPath = isAbsolute(def.file) ? def.file : resolve(baseDir, def.file);
      const fn = await loadMatcherFile(absPath);
      if (fn) {
        loaded.push({ file: def.file, name: def.name, fn });
      }
    }
    this.rules = loaded;
    logger.info('Matcher rules loaded', {
      count: loaded.length,
      rules: loaded.map((r) => `${r.name} (${r.file})`),
    });
  }

}

// ── Executor ───────────────────────────────────────────────────────────

/**
 * Run all loaded matcher rules and return matched names.
 *
 *  ┌──────────────────────┐     ┌──────────────────────┐
 *  │  Evaluate all        │     │  resolveComboChain    │
 *  │  matcher predicates  │     │  uses matched names   │
 *  │  → Set of matched    │────→│  to filter model refs │
 *  │    names             │     │  in the requested     │
 *  └──────────────────────┘     │  combo                │
 *       OR                      └──────────────────────┘
 *  ┌──────────────────────┐
 *  │  Router function     │────→  resolveRouterCandidates
 *  │  → RouterCandidate[] │       (filter, expand combos)
 *  └──────────────────────┘
 *
 * Returns the set of matcher names that matched.
 * Fail-open: errors are caught and logged, never block routing.
 */
export async function runMatchers(
  ctx: MatchContext,
): Promise<Set<string>> {
  const registry = MatcherRegistry.getInstance();
  const rules = registry.getRules();

  // Evaluate all matchers, collect matched names
  const matchedNames = new Set<string>();
  for (const rule of rules) {
    try {
      const result = await rule.fn(ctx);

      if (result === true) {
        matchedNames.add(rule.name);
        logger.info('Matcher matched', {
          name: rule.name,
          file: rule.file,
          original: ctx.requestedModel,
        });
      } else {
        logger.debug('Matcher skipped', { name: rule.name });
      }
    } catch (error) {
      logger.warn('Matcher threw error, continuing', {
        name: rule.name,
        file: rule.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (matchedNames.size === 0) {
    logger.debug('No matcher matched, using default routing', {
      requestedModel: ctx.requestedModel,
    });
  }

  return matchedNames;
}
