import { expect, test } from 'bun:test';
import router from '../src/router.js';
import { CONFIG_PATH_ENV_VAR, getConfig, getModelName, loadConfig, updateConfig } from '../src/config.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function runCcsAgyModelCheck(model: string, timeoutMs = 20000): Promise<{
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn({
    cmd: [
      'ccs',
      'agy',
      '--dangerously-skip-permissions',
      '--model',
      model,
      '-p',
      'hello'
    ],
    stdout: 'pipe',
    stderr: 'pipe'
  });

  const timeout = new Promise<{ timedOut: true; exitCode: null; stdout: string; stderr: string }>((resolve) => {
    setTimeout(() => {
      proc.kill();
      resolve({ timedOut: true, exitCode: null, stdout: '', stderr: 'timed out' });
    }, timeoutMs);
  });

  const completed = (async () => {
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { timedOut: false, exitCode, stdout, stderr };
  })();

  return Promise.race([completed, timeout]);
}

function parseMaxModelsFromEnv(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function inferFailureReason(failure: {
  proxyStatus: number;
  proxyPayload: unknown;
  ccsTimedOut?: boolean;
  ccsExitCode?: number | null;
}): string {
  if (failure.ccsTimedOut) {
    return 'proxy_failed_ccs_timed_out';
  }

  let errorType: string | undefined;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  if (isRecord(failure.proxyPayload) && isRecord(failure.proxyPayload.error)) {
    const providerError = failure.proxyPayload.error;
    if (typeof providerError.type === 'string') {
      errorType = providerError.type;
    }
    if (typeof providerError.code === 'string') {
      errorCode = providerError.code;
    }
    if (typeof providerError.message === 'string') {
      errorMessage = providerError.message;
    }
  }

  if (errorCode) {
    return `${failure.proxyStatus}:${errorCode}`;
  }
  if (errorType) {
    return `${failure.proxyStatus}:${errorType}`;
  }
  if (typeof errorMessage === 'string' && errorMessage.length > 0) {
    if (errorMessage.includes('QUOTA_PACING_VIOLATION')) return `${failure.proxyStatus}:QUOTA_PACING_VIOLATION`;
    if (errorMessage.includes('unknown provider for model')) return `${failure.proxyStatus}:unknown_provider_for_model`;
  }

  return `${failure.proxyStatus}:unknown`;
}

test('provider e2e: free models (qwen + glm-4.7-flash, or one via E2E_PROVIDER_ID)', async () => {
  const originalConfigPathEnv = process.env[CONFIG_PATH_ENV_VAR];
  const e2eConfigPath = process.env.E2E_CONFIG_PATH;
  if (e2eConfigPath) {
    process.env[CONFIG_PATH_ENV_VAR] = e2eConfigPath;
  }

  await loadConfig(true);
  const originalConfig = getConfig();
  const selectedProviderId = process.env.E2E_PROVIDER_ID;
  const defaultFreeProviderIds = ['ccs-qwen', 'z-ai'].filter((providerId) => providerId in originalConfig.providers);
  const providerIdsToTest = selectedProviderId ? [selectedProviderId] : defaultFreeProviderIds;
  const modelFromEnv = process.env.E2E_MODEL;
  const maxModels = parseMaxModelsFromEnv(process.env.E2E_MAX_MODELS);
  const failures: Array<{
    providerId: string;
    model: string;
    proxyStatus: number;
    proxyPayload: unknown;
    ccsTimedOut?: boolean;
    ccsExitCode?: number | null;
    ccsStdout?: string;
    ccsStderr?: string;
  }> = [];
  const perProviderStats: Record<string, { testedModels: number; failedModels: number; failuresByReason: Record<string, string[]> }> = {};

  try {
    for (const providerId of providerIdsToTest) {
      const provider = originalConfig.providers[providerId];
      expect(provider).toBeDefined();
      if (!provider) {
        continue;
      }

      let modelsToTest: string[] = modelFromEnv
        ? [modelFromEnv]
        : providerId === 'ccs-qwen'
          ? ['coder-model', 'qwen3-coder-flash', 'qwen3-coder-plus', 'vision-model']
          : providerId === 'z-ai'
            ? ['glm-4.7-flash']
            : [];
      if (!modelFromEnv && maxModels) {
        modelsToTest = modelsToTest.slice(0, maxModels);
      }

      expect(modelsToTest.length).toBeGreaterThan(0);
      if (modelsToTest.length === 0) {
        continue;
      }

      const config = structuredClone(originalConfig);
      // Never persist test-side auto-deletes to disk during e2e.
      for (const [id, p] of Object.entries(config.providers)) {
        p.autoDeleteModels = false;
        p.persistAutoDeletedModels = false;
        // Make direct-model routing provider-specific for this test.
        if (id !== providerId) {
          p.models = [];
        }
      }

      updateConfig(config);

      const providerFailures: typeof failures = [];
      for (const model of modelsToTest) {
        const response = await router.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
            max_tokens: 16,
            temperature: 0
          })
        });

        const payload = await response.json().catch(() => ({}));

        if (providerId === 'ccs-agy') {
          if (response.status !== 200) {
            const ccsCheck = await runCcsAgyModelCheck(model);
            const ccsSucceeded = !ccsCheck.timedOut && ccsCheck.exitCode === 0;

            // Failure only when proxy fails while direct CCS succeeds.
            if (ccsSucceeded) {
              providerFailures.push({
                providerId,
                model,
                proxyStatus: response.status,
                proxyPayload: payload,
                ccsTimedOut: ccsCheck.timedOut,
                ccsExitCode: ccsCheck.exitCode,
                ccsStdout: ccsCheck.stdout,
                ccsStderr: ccsCheck.stderr
              });
            }
          }
        } else if (response.status !== 200) {
          providerFailures.push({
            providerId,
            model,
            proxyStatus: response.status,
            proxyPayload: payload
          });
        }
      }

      failures.push(...providerFailures);
      const groupedFailures = providerFailures.reduce<Record<string, string[]>>((acc, failure) => {
        const reason = inferFailureReason(failure);
        if (!acc[reason]) {
          acc[reason] = [];
        }
        acc[reason].push(failure.model);
        return acc;
      }, {});
      perProviderStats[providerId] = {
        testedModels: modelsToTest.length,
        failedModels: providerFailures.length,
        failuresByReason: groupedFailures
      };
    }
  } finally {
    // Restore in-memory config after test run.
    updateConfig(originalConfig);
    if (e2eConfigPath) {
      if (originalConfigPathEnv === undefined) {
        delete process.env[CONFIG_PATH_ENV_VAR];
      } else {
        process.env[CONFIG_PATH_ENV_VAR] = originalConfigPathEnv;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        providersTested: providerIdsToTest,
        stats: perProviderStats
      },
      null,
      2
    )
  );

  expect(failures).toEqual([]);
}, 600_000);
