import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigSchema, CONFIG_PATH_ENV_VAR, getConfig, loadConfig, updateConfig } from '../src/config.js';

function makeMinimalConfig() {
  return ConfigSchema.parse({
    providers: {
      p1: {
        baseUrl: 'http://example.com',
        description: 'provider 1',
        timeout: 5_000,
        apiKey: 'dummy',
        models: ['m1']
      }
    },
    combos: {
      test: {
        description: 'test combo',
        models: [{ provider: 'p1', model: 'm1' }]
      }
    }
  });
}

test('loadConfig reads from config path env override', async () => {
  const originalPathEnv = process.env[CONFIG_PATH_ENV_VAR];
  const tempDir = mkdtempSync(join(tmpdir(), 'llm-fallback-proxy-config-path-'));
  const configFilePath = join(tempDir, 'custom-config.json');

  try {
    const config = makeMinimalConfig();
    writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8');

    process.env[CONFIG_PATH_ENV_VAR] = configFilePath;

    await loadConfig(true);
    const loadedConfig = getConfig();

    expect(Object.keys(loadedConfig.providers)).toEqual(['p1']);
    expect(loadedConfig.providers.p1.models).toEqual(['m1']);
  } finally {
    updateConfig(makeMinimalConfig());
    if (originalPathEnv === undefined) {
      delete process.env[CONFIG_PATH_ENV_VAR];
    } else {
      process.env[CONFIG_PATH_ENV_VAR] = originalPathEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadConfig autoPopulateModels merges discovered models with manual models', async () => {
  const originalPathEnv = process.env[CONFIG_PATH_ENV_VAR];
  const tempDir = mkdtempSync(join(tmpdir(), 'llm-fallback-proxy-config-path-'));
  const configFilePath = join(tempDir, 'custom-config.json');

  try {
    const config = ConfigSchema.parse({
      providers: {
        p1: {
          baseUrl: 'http://example.com',
          description: 'provider 1',
          timeout: 5_000,
          apiKey: 'dummy',
          autoPopulateModels: true,
          persistAutoPopulatedModels: false,
          modelsServer: {
            type: 'stdio',
            command: 'bash',
            args: ['-lc', 'printf "discovered-1\ndiscovered-2\n"']
          },
          models: ['manual-1']
        }
      },
      combos: {
        test: {
          description: 'test combo',
          models: [{ provider: 'p1', model: 'manual-1' }]
        }
      }
    });

    writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8');
    process.env[CONFIG_PATH_ENV_VAR] = configFilePath;

    await loadConfig(true);
    const loadedConfig = getConfig();

    expect(loadedConfig.providers.p1.models).toEqual(['discovered-1', 'discovered-2', 'manual-1']);
  } finally {
    updateConfig(makeMinimalConfig());
    if (originalPathEnv === undefined) {
      delete process.env[CONFIG_PATH_ENV_VAR];
    } else {
      process.env[CONFIG_PATH_ENV_VAR] = originalPathEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
