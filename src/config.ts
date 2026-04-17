// ABOUTME: Config loader with Zod validation, cycle detection, and hot-reload
// ABOUTME: Loads config.json and watches for changes to reload automatically

import { readFile, writeFile } from 'fs/promises';
import { existsSync, watch as watchFs, FSWatcher } from 'fs';
import { resolve, isAbsolute } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { logger } from './logger.js';
import { z } from 'zod';
import { fetchProviderModels } from './model-discovery.js';
import { ServerSchema } from './server-config-builder.js';
export type { ServerConfig } from './server-config-builder.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ── Environment variable interpolation ────────────────────────────────

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Interpolate `${VAR}` references in all string values within a config object.
 * Replaces each `${VAR_NAME}` with the corresponding `process.env.VAR_NAME` value.
 * Throws if any referenced env var is not set.
 */
export function interpolateEnvVars(value: unknown, path = ''): unknown {
  if (typeof value === 'string') {
    const missing: string[] = [];
    const result = value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        missing.push(varName);
        return match;
      }
      return envValue;
    });

    if (missing.length > 0) {
      const location = path ? ` at ${path}` : '';
      throw new Error(
        `Config references undefined environment variable(s): ${missing.join(', ')}${location}`
      );
    }

    return result;
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnvVars(item, `${path}[${i}]`));
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnvVars(v, path ? `${path}.${k}` : k);
    }
    return out;
  }

  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

import { homedir } from 'os';
export const DEFAULT_CONFIG_PATH = pathToFileURL(resolve(homedir(), '.config', 'llm-fallback-proxy', 'config.json'));
export const CONFIG_PATH_ENV_VAR = 'LLM_FALLBACK_PROXY_CONFIG_PATH';
export const CONFIG_SCHEMA_PATH = new URL('../config.schema.json', import.meta.url);

export function getConfigPath(): URL {
  const configuredPath = process.env[CONFIG_PATH_ENV_VAR]?.trim();
  if (!configuredPath) {
    return DEFAULT_CONFIG_PATH;
  }

  if (/^https?:\/\//i.test(configuredPath)) {
    throw new Error(`${CONFIG_PATH_ENV_VAR} must be a filesystem path, not an HTTP URL`);
  }

  const parsedPath = (() => {
    try {
      return new URL(configuredPath);
    } catch {
      return null;
    }
  })();

  if (parsedPath) {
    if (parsedPath.protocol !== 'file:') {
      throw new Error(`${CONFIG_PATH_ENV_VAR} must be a filesystem path or file:// URL`);
    }

    return pathToFileURL(fileURLToPath(parsedPath));
  }

  const absolutePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(process.cwd(), configuredPath);

  return pathToFileURL(absolutePath);
}

// Zod schemas for validation
const ModelRefSchema = z.object({
  provider: z.string().optional(),
  model: z.string().min(1),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;

const ModelsComboSchema = z.object({
  description: z.string(),
  models: z.array(ModelRefSchema).min(1, 'Combo must have at least one model'),
}).strict();

const RouterComboSchema = z.object({
  description: z.string(),
  router: z.string().min(1, 'Router path must be a non-empty string'),
}).strict();

const ComboConfigSchema = z.union([ModelsComboSchema, RouterComboSchema]);

export type ModelsComboConfig = z.infer<typeof ModelsComboSchema>;
export type RouterComboConfig = z.infer<typeof RouterComboSchema>;
export type ComboConfig = z.infer<typeof ComboConfigSchema>;

const QuotaConfigSchema = z.object({
  usageServer: ServerSchema,
  quotaRemaining: z.object({
    path: z.string(),
    overdraftPercent: z.number().nonnegative().optional()
  }).optional(),
  reset: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('timestamp'),
      path: z.string()
    }),
    z.object({
      mode: z.literal('rolling-window'),
      latestStartTimestamp: z.iso.datetime().optional(),
      durationPath: z.string()
    })
  ]).optional(),
  cacheTTLSeconds: z.number().nonnegative().optional(),
  timeoutSeconds: z.number().positive().optional()
});

export type QuotaConfig = z.infer<typeof QuotaConfigSchema>;

// Provider model entry can be either a string (model name) or an object with name and optional quota
const ProviderModelEntryString = z.string();
const ModelQuotaOverrideSchema = z.object({
  usageServer: ServerSchema,
  quotaRemaining: z.object({
    path: z.string(),
    overdraftPercent: z.number().nonnegative().optional()
  }),
  reset: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('timestamp'),
      path: z.string()
    }),
    z.object({
      mode: z.literal('rolling-window'),
      latestStartTimestamp: z.iso.datetime().optional(),
      durationPath: z.string()
    })
  ]),
  cacheTTLSeconds: z.number().nonnegative().optional(),
  timeoutSeconds: z.number().positive().optional()
});

const ModelQuotaTemplateSchema = z.object({
  quotaRemaining: ModelQuotaOverrideSchema.shape.quotaRemaining,
  reset: ModelQuotaOverrideSchema.shape.reset,
  cacheTTLSeconds: ModelQuotaOverrideSchema.shape.cacheTTLSeconds.optional(),
  timeoutSeconds: ModelQuotaOverrideSchema.shape.timeoutSeconds.optional()
});

const AutoPopulateModelQuotasSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().default(false),
    modelQuotaTemplate: ModelQuotaTemplateSchema.optional()
  })
]);

const ProviderModelEntryObject = z.object({
  name: z.string().min(1),
  quota: ModelQuotaOverrideSchema.optional()
});
const ProviderModelEntry = z.union([ProviderModelEntryString, ProviderModelEntryObject]);

export type ProviderModelEntry = z.infer<typeof ProviderModelEntry>;

// Helper to extract model name from a provider model entry
export function getModelName(entry: ProviderModelEntry): string {
  if (typeof entry === 'string') {
    return entry;
  }
  return entry.name;
}

// Helper to extract quota config from a provider model entry
export function getModelQuota(entry: ProviderModelEntry, providerQuota?: QuotaConfig): QuotaConfig | undefined {
  if (typeof entry === 'string') {
    return undefined;
  }

  // No extending behavior: only explicit model quota is returned.
  void providerQuota;
  return entry.quota;
}

const ProviderConfigSchema = z.object({
  baseUrl: z.url(),
  description: z.string(),
  timeout: z.number().positive('Provider timeout must be positive'),
  apiKey: z.string(),
  modelsServer: ServerSchema.optional(),
  autoPopulateModels: z.boolean().optional().default(false),
  autoPopulateModelQuotas: AutoPopulateModelQuotasSchema.optional().default(false),
  persistAutoPopulatedModels: z.boolean().optional().default(false),
  persistAutoPopulatedModelQuotas: z.boolean().optional().default(false),
  models: z.array(ProviderModelEntry).optional().default([]),
  statusCodes: z.object({
    'fail-fast': z.array(z.number()).optional(),
    'unknown-model': z.array(z.number()).optional(),
    quotaExhausted: z.array(z.number()).optional(),
  }).optional(),
  quotaExhaustedCacheTTLSeconds: z.number().positive().optional(),
  autoDeleteModels: z.boolean().optional().default(false),
  persistAutoDeletedModels: z.boolean().optional().default(false),
  quota: QuotaConfigSchema.optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema),
  combos: z.record(z.string(), ComboConfigSchema),
});

export type Config = z.infer<typeof ConfigSchema>;

// Cycle detection using DFS
function detectCircularRefs(
  comboName: string,
  combos: Record<string, ComboConfig>,
  providerNames: Set<string>,
  visited: Set<string> = new Set(),
  path: string[] = []
): { hasCycle: boolean; cyclePath?: string[] } {
  if (visited.has(comboName)) {
    const cycleStart = path.indexOf(comboName);
    return {
      hasCycle: true,
      cyclePath: [...path.slice(cycleStart), comboName]
    };
  }

  const combo = combos[comboName];
  if (!combo) {
    return { hasCycle: false };
  }

  // Router combos have no static model refs — skip cycle detection
  if (!('models' in combo)) {
    return { hasCycle: false };
  }

  const newVisited = new Set(visited).add(comboName);
  const newPath = [...path, comboName];

  for (const modelRef of combo.models) {
    // Check if this is a reference to another combo (no provider specified)
    if (!modelRef.provider && combos[modelRef.model]) {
      const result = detectCircularRefs(modelRef.model, combos, providerNames, newVisited, newPath);
      if (result.hasCycle) {
        return result;
      }
    }

    // Validate provider exists if specified
    if (modelRef.provider && !providerNames.has(modelRef.provider)) {
      throw new Error(`Unknown provider "${modelRef.provider}" referenced in combo "${comboName}"`);
    }
  }

  return { hasCycle: false };
}

function validateAndCheckCycles(config: Config): Config {
  const providerNames = new Set(Object.keys(config.providers));

  // Check for circular references and validate provider references
  for (const [name, combo] of Object.entries(config.combos)) {
    const cycleCheck = detectCircularRefs(name, config.combos, providerNames);
    if (cycleCheck.hasCycle) {
      throw new Error(
        `Circular reference detected in combo "${name}": ${cycleCheck.cyclePath!.join(' -> ')}`
      );
    }
  }

  return config;
}

let currentConfig: Config | null = null;
let watcher: FSWatcher | null = null;
let watcherConfigPathname: string | null = null;

function escapeJsonPathString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getAutoPopulateModelQuotasConfig(providerConfig: ProviderConfig): {
  enabled: boolean;
  modelQuotaTemplate?: z.infer<typeof ModelQuotaTemplateSchema>;
  legacyBoolean: boolean;
} {
  if (typeof providerConfig.autoPopulateModelQuotas === 'boolean') {
    return { enabled: providerConfig.autoPopulateModelQuotas, legacyBoolean: true };
  }
  return {
    enabled: providerConfig.autoPopulateModelQuotas.enabled,
    modelQuotaTemplate: providerConfig.autoPopulateModelQuotas.modelQuotaTemplate,
    legacyBoolean: false
  };
}

function applyModelQuotaTemplateUnknown(value: unknown, modelName: string): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('{model.name}', escapeJsonPathString(modelName));
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyModelQuotaTemplateUnknown(item, modelName));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = applyModelQuotaTemplateUnknown(v, modelName);
    }
    return out;
  }
  return value;
}

function modelsEqual(a: ProviderModelEntry[] = [], b: ProviderModelEntry[] = []): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeProviderModels(models: ProviderModelEntry[] = []): ProviderModelEntry[] {
  const deduped = new Map<string, ProviderModelEntry>();
  for (const entry of models) {
    const name = getModelName(entry);
    if (!deduped.has(name)) {
      deduped.set(name, entry);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => getModelName(a).localeCompare(getModelName(b)));
}

function providerHasModel(provider: ProviderConfig, model: string): boolean {
  if (model === 'all') return true;
  return (provider.models ?? []).some((entry) => getModelName(entry) === model);
}

function pruneStaleProviderModelRefs(config: Config): Array<{ combo: string; provider: string; model: string }> {
  const removed: Array<{ combo: string; provider: string; model: string }> = [];

  for (const [comboName, combo] of Object.entries(config.combos)) {
    // Router combos have no static model refs — skip
    if (!('models' in combo)) continue;

    const filtered = combo.models.filter((ref) => {
      if (!ref.provider) return true;
      const provider = config.providers[ref.provider];
      if (!provider) return true;
      const valid = providerHasModel(provider, ref.model);
      if (!valid) {
        removed.push({ combo: comboName, provider: ref.provider, model: ref.model });
      }
      return valid;
    });

    if (filtered.length > 0 && filtered.length !== combo.models.length) {
      combo.models = filtered;
    }
  }

  return removed;
}

export async function loadConfig(forceReload = false): Promise<Config> {
  if (currentConfig && !forceReload) {
    return currentConfig;
  }

  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath.pathname}`);
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const rawParsed = JSON.parse(content);
    const rawConfig = interpolateEnvVars(rawParsed) as Record<string, unknown>;

    // Enforce modelsServer-only model discovery configuration
    for (const [providerName, providerConfig] of Object.entries(rawConfig.providers || {})) {
      if (providerConfig && typeof providerConfig === 'object' && 'modelsEndpoint' in providerConfig) {
        throw new Error(
          `Provider "${providerName}" uses deprecated "modelsEndpoint". Use "modelsServer" with type "http" or "stdio" instead.`
        );
      }
    }

    // Parse and validate with Zod
    const parsedConfig = ConfigSchema.parse(rawConfig);
    let shouldPersistAutoPopulated = false;

    // Auto-populate provider models when requested (or when models are empty)
    for (const [providerName, providerConfig] of Object.entries(parsedConfig.providers)) {
      providerConfig.models = normalizeProviderModels(providerConfig.models ?? []);
      const originalModels = [...providerConfig.models];
      let providerModelsChanged = false;
      const shouldAutoPopulate =
        !!providerConfig.modelsServer &&
        (providerConfig.autoPopulateModels || !providerConfig.models || providerConfig.models.length === 0);

      if (shouldAutoPopulate) {
        const models = await fetchProviderModels(providerName, providerConfig);
        if (models.length > 0) {
          providerConfig.models = normalizeProviderModels([
            ...(providerConfig.models ?? []),
            ...models
          ]);
        } else if (!providerConfig.models || providerConfig.models.length === 0) {
          providerConfig.models = [];
        }

        if (!forceReload && providerConfig.persistAutoPopulatedModels && !modelsEqual(originalModels, providerConfig.models)) {
          providerModelsChanged = true;
          shouldPersistAutoPopulated = true;
        }
      }

      const autoPopulateModelQuotasConfig = getAutoPopulateModelQuotasConfig(providerConfig);
      if (autoPopulateModelQuotasConfig.enabled) {
        if (!providerConfig.quota?.usageServer) {
          throw new Error(`Provider "${providerName}" enables autoPopulateModelQuotas but has no provider quota.usageServer`);
        }
        if (!autoPopulateModelQuotasConfig.modelQuotaTemplate) {
          if (autoPopulateModelQuotasConfig.legacyBoolean) {
            logger.warn('Skipping autoPopulateModelQuotas: missing modelQuotaTemplate for legacy boolean config', {
              provider: providerName
            });
          } else {
            throw new Error(`Provider "${providerName}" enables autoPopulateModelQuotas but has no modelQuotaTemplate`);
          }
          continue;
        }

        providerConfig.models = (providerConfig.models ?? []).map((entry) => {
          if (typeof entry === 'object' && entry.quota) {
            return entry;
          }
          const name = getModelName(entry);
          const renderedTemplateRaw = applyModelQuotaTemplateUnknown(autoPopulateModelQuotasConfig.modelQuotaTemplate!, name);
          const renderedTemplate = ModelQuotaTemplateSchema.parse(renderedTemplateRaw);
          return {
            name,
            quota: {
              usageServer: providerConfig.quota!.usageServer,
              quotaRemaining: renderedTemplate.quotaRemaining,
              reset: renderedTemplate.reset,
              cacheTTLSeconds: renderedTemplate.cacheTTLSeconds,
              timeoutSeconds: renderedTemplate.timeoutSeconds
            }
          };
        });
        providerConfig.models = normalizeProviderModels(providerConfig.models);

        if (!forceReload && providerConfig.persistAutoPopulatedModelQuotas && !modelsEqual(originalModels, providerConfig.models)) {
          providerModelsChanged = true;
          shouldPersistAutoPopulated = true;
        }
      }

      if (providerModelsChanged) {
        const providers = rawConfig.providers as Record<string, Record<string, unknown>>;
        if (!providers[providerName] || typeof providers[providerName] !== 'object') {
          providers[providerName] = {};
        }
        providers[providerName].models = providerConfig.models;
      }
    }

    const removedRefs = pruneStaleProviderModelRefs(parsedConfig);
    if (!forceReload && removedRefs.length > 0) {
      shouldPersistAutoPopulated = true;
      rawConfig.combos = parsedConfig.combos;
      logger.warn('Pruned stale provider/model refs from combos', {
        removed: removedRefs.length,
        refs: removedRefs.slice(0, 20)
      });
    }

    if (shouldPersistAutoPopulated) {
      await writeFile(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
      logger.info('Persisted auto-populated provider models to config file', { path: configPath.pathname });
    }

    // Check for circular references and validate provider references
    currentConfig = validateAndCheckCycles(parsedConfig);

    logger.info('Config loaded successfully', {
      providers: Object.keys(currentConfig.providers).length,
      combos: Object.keys(currentConfig.combos).length
    });
    return currentConfig;
  } catch (error) {
    // Check for ZodError
    if (error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)) {
      const errorDetails = error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw new Error(`Config validation failed: ${errorDetails}`);
    }
    if (error instanceof Error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
    throw error;
  }
}

export function getConfig(): Config {
  if (!currentConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return currentConfig;
}

/**
 * Update the in-memory config without persisting to disk
 */
export function updateConfig(config: Config): void {
  currentConfig = config;
}

/**
 * Save config to file and update in-memory config
 */
export async function saveConfig(config: Config): Promise<void> {
  const configPath = getConfigPath();
  const json = JSON.stringify(config, null, 2);
  await writeFile(configPath, json, 'utf-8');
  currentConfig = config;
  logger.info('Config saved to disk', { path: configPath.pathname });
}

/**
 * Post-process JSON schema to remove fields with defaults from required arrays
 * Zod's toJSONSchema() incorrectly includes fields with .default() in required arrays
 */
function postProcessJsonSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return schema;
  }

  const obj = schema;

  // If this object has a 'properties' and 'required' array, process it
  if (isRecord(obj.properties) && isStringArray(obj.required)) {
    const properties = obj.properties;
    const required = obj.required;

    // Remove fields from required if they have a default value
    const filteredRequired = required.filter(field => {
      const fieldDef = properties[field];
      if (isRecord(fieldDef) && 'default' in fieldDef) {
        return false; // Has a default, so not required
      }
      return true;
    });

    // Update the required array
    if (filteredRequired.length !== required.length) {
      obj.required = filteredRequired;
    }
  }

  // Recursively process nested objects
  for (const key in obj) {
    const value = obj[key];
    if (key === 'properties' && isRecord(value)) {
      // Process each property definition
      for (const propKey in value) {
        value[propKey] = postProcessJsonSchema(value[propKey]);
      }
    } else if (isUnknownArray(value)) {
      // Process array items
      obj[key] = value.map(item => postProcessJsonSchema(item));
    } else if (isRecord(value)) {
      obj[key] = postProcessJsonSchema(value);
    }
  }

  return obj;
}

/**
 * Generate JSON Schema from Zod schema and write to file
 */
export async function generateConfigSchema(): Promise<void> {
  try {
    const jsonSchema = ConfigSchema.extend({
      $schema: z.string()
    }).toJSONSchema();

    // Post-process to fix Zod's incorrect required handling for fields with defaults
    const processedSchema = postProcessJsonSchema(jsonSchema);

    // Add schema metadata
    const schemaWithMetaBase = {
      $id: 'https://llm-fallback-proxy/schemas/config.json',
      title: 'LLM Fallback Proxy Configuration',
      description: 'Configuration schema for the LLM Fallback Proxy',
    };
    const schemaWithMeta = isRecord(processedSchema)
      ? {
          ...schemaWithMetaBase,
          ...processedSchema,
        }
      : schemaWithMetaBase;

    await writeFile(CONFIG_SCHEMA_PATH, JSON.stringify(schemaWithMeta, null, 2), 'utf-8');
    logger.info('Config schema generated', { path: CONFIG_SCHEMA_PATH.pathname });
  } catch (error) {
    logger.error('Failed to generate config schema', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function startConfigWatcher(): Promise<void> {
  const configPathUrl = getConfigPath();
  const configPath = configPathUrl.pathname;

  if (watcher) {
    if (watcherConfigPathname === configPath) {
      logger.warn('Config watcher already running');
      return;
    }
    watcher.close();
    watcher = null;
    watcherConfigPathname = null;
  }

  try {
    const configDir = new URL('.', configPathUrl).pathname;
    const configFileName = configPath.split('/').pop() ?? 'config.json';

    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let reloading = false;
    let queuedReload = false;

    const performReload = async () => {
      if (reloading) {
        queuedReload = true;
        return;
      }

      do {
        queuedReload = false;
        reloading = true;
        try {
          logger.info('Config file changed, reloading...');
          await loadConfig(true);
          logger.info('Config reloaded successfully');

          // Reload router if router file changed
          const { RouterRegistry } = await import('./router-registry.js');
          const newConfig = getConfig();
          let routerFile: string | null = null;
          for (const combo of Object.values(newConfig.combos)) {
            if ('router' in combo) { routerFile = combo.router; break; }
          }
          const configDir = new URL('.', getConfigPath()).pathname;
          await RouterRegistry.getInstance().reloadIfNeeded(routerFile, configDir);
        } catch (error) {
          logger.error('Failed to reload config', { error: error instanceof Error ? error.message : String(error) });
        } finally {
          reloading = false;
        }
      } while (queuedReload);
    };

    const scheduleReload = () => {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }
      reloadTimer = setTimeout(() => {
        void performReload();
      }, 100);
    };

    // Watch the parent directory so atomic rename/replace writes are detected.
    watcher = watchFs(configDir, (eventType, filename) => {
      const changedFile = filename?.toString();
      if (changedFile && changedFile !== configFileName) {
        return;
      }
      if (eventType === 'change' || eventType === 'rename') {
        scheduleReload();
      }
    });

    watcherConfigPathname = configPath;

    watcher.on('error', (error) => {
      logger.error('Config watcher error', { error: error instanceof Error ? error.message : String(error) });
    });

    logger.info('Config watcher started', { path: configPath, mode: 'directory' });
  } catch (error) {
    logger.error('Failed to start config watcher', { error: error instanceof Error ? error.message : String(error) });
  }
}
