// ABOUTME: Config loader with Zod validation, cycle detection, and hot-reload
// ABOUTME: Loads config.json and watches for changes to reload automatically

import { readFile, watch, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { logger } from './logger.js';
import { z } from 'zod';
import { fetchProviderModels } from './model-discovery.js';

export const CONFIG_PATH = new URL('../config.json', import.meta.url);
export const CONFIG_SCHEMA_PATH = new URL('../config.schema.json', import.meta.url);

// Zod schemas for validation
const ModelRefSchema = z.object({
  provider: z.string().optional(),
  model: z.string().min(1),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;

const ComboConfigSchema = z.object({
  description: z.string(),
  models: z.array(ModelRefSchema).min(1, 'Combo must have at least one model'),
});

export type ComboConfig = z.infer<typeof ComboConfigSchema>;

const ServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional()
  }),
  z.object({
    type: z.literal('http'),
    url: z.url()
  })
]);

export type ServerConfig = z.infer<typeof ServerSchema>;

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
  unknownModelStatusCode: z.number().optional(),
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
let watcher: AsyncIterable<Uint8Array> | null = null;

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

function applyModelQuotaTemplate<T>(value: T, modelName: string): T {
  if (typeof value === 'string') {
    return value.replaceAll('{model.name}', escapeJsonPathString(modelName)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyModelQuotaTemplate(item, modelName)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = applyModelQuotaTemplate(v, modelName);
    }
    return out as T;
  }
  return value;
}

function modelsEqual(a: ProviderModelEntry[] = [], b: ProviderModelEntry[] = []): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function loadConfig(forceReload = false): Promise<Config> {
  if (currentConfig && !forceReload) {
    return currentConfig;
  }

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH.pathname}`);
  }

  try {
    const content = await readFile(CONFIG_PATH, 'utf-8');
    const rawConfig = JSON.parse(content);

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
      const originalModels = [...(providerConfig.models ?? [])];
      let providerModelsChanged = false;
      const shouldAutoPopulate =
        !!providerConfig.modelsServer &&
        (providerConfig.autoPopulateModels || !providerConfig.models || providerConfig.models.length === 0);

      if (shouldAutoPopulate) {
        const models = await fetchProviderModels(providerName, providerConfig);
        if (models.length > 0) {
          providerConfig.models = models;
        } else if (!providerConfig.models || providerConfig.models.length === 0) {
          providerConfig.models = [];
        }

        if (providerConfig.persistAutoPopulatedModels && !modelsEqual(originalModels, providerConfig.models)) {
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
          const renderedTemplate = applyModelQuotaTemplate(autoPopulateModelQuotasConfig.modelQuotaTemplate!, name);
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

        if (providerConfig.persistAutoPopulatedModelQuotas && !modelsEqual(originalModels, providerConfig.models)) {
          providerModelsChanged = true;
          shouldPersistAutoPopulated = true;
        }
      }

      if (providerModelsChanged) {
        if (!rawConfig.providers[providerName] || typeof rawConfig.providers[providerName] !== 'object') {
          rawConfig.providers[providerName] = {};
        }
        rawConfig.providers[providerName].models = providerConfig.models;
      }
    }

    if (shouldPersistAutoPopulated) {
      await writeFile(CONFIG_PATH, JSON.stringify(rawConfig, null, 2), 'utf-8');
      logger.info('Persisted auto-populated provider models to config file', { path: CONFIG_PATH.pathname });
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
  const json = JSON.stringify(config, null, 2);
  await writeFile(CONFIG_PATH, json, 'utf-8');
  currentConfig = config;
  logger.info('Config saved to disk', { path: CONFIG_PATH.pathname });
}

/**
 * Post-process JSON schema to remove fields with defaults from required arrays
 * Zod's toJSONSchema() incorrectly includes fields with .default() in required arrays
 */
function postProcessJsonSchema(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }

  const obj = schema as Record<string, unknown>;

  // If this object has a 'properties' and 'required' array, process it
  if ('properties' in obj && typeof obj.properties === 'object' && obj.properties !== null &&
      'required' in obj && Array.isArray(obj.required)) {
    const properties = obj.properties as Record<string, unknown>;
    const required = obj.required as string[];

    // Remove fields from required if they have a default value
    const filteredRequired = required.filter(field => {
      const fieldDef = properties[field];
      if (typeof fieldDef === 'object' && fieldDef !== null && 'default' in fieldDef) {
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
    if (key === 'properties' && typeof obj[key] === 'object' && obj[key] !== null) {
      // Process each property definition
      for (const propKey in obj[key] as Record<string, unknown>) {
        (obj[key] as Record<string, unknown>)[propKey] = postProcessJsonSchema(
          (obj[key] as Record<string, unknown>)[propKey]
        );
      }
    } else if (Array.isArray(obj[key])) {
      // Process array items
      obj[key] = (obj[key] as unknown[]).map(item => postProcessJsonSchema(item));
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      obj[key] = postProcessJsonSchema(obj[key]);
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
    const processedSchemaObj = processedSchema as Record<string, unknown>;
    const schemaWithMeta = {
      $id: 'https://llm-fallback-proxy/schemas/config.json',
      title: 'LLM Fallback Proxy Configuration',
      description: 'Configuration schema for the LLM Fallback Proxy',
      ...processedSchemaObj
    };

    await writeFile(CONFIG_SCHEMA_PATH, JSON.stringify(schemaWithMeta, null, 2), 'utf-8');
    logger.info('Config schema generated', { path: CONFIG_SCHEMA_PATH.pathname });
  } catch (error) {
    logger.error('Failed to generate config schema', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function startConfigWatcher(): Promise<void> {
  if (watcher) {
    logger.warn('Config watcher already running');
    return;
  }

  try {
    const ac = new AbortController();
    const { default: watchFs } = await import('fs');

    // Use fs.watch() for file watching
    watchFs.watch(CONFIG_PATH.pathname, async (eventType) => {
      if (eventType === 'change') {
        try {
          logger.info('Config file changed, reloading...');
          await loadConfig(true);
          logger.info('Config reloaded successfully');
        } catch (error) {
          logger.error('Failed to reload config', { error: error instanceof Error ? error.message : String(error) });
        }
      }
    });

    logger.info('Config watcher started', { path: CONFIG_PATH.pathname });
  } catch (error) {
    logger.error('Failed to start config watcher', { error: error instanceof Error ? error.message : String(error) });
  }
}
