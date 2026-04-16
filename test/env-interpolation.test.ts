import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { interpolateEnvVars } from '../src/config.js';

describe('Environment variable interpolation', () => {
  const originals: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save original env values
  });

  afterEach(() => {
    // Restore env values
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function setEnv(key: string, value: string) {
    originals[key] = process.env[key];
    process.env[key] = value;
  }

  function clearEnv(key: string) {
    originals[key] = process.env[key];
    delete process.env[key];
  }

  describe('string interpolation', () => {
    test('replaces ${VAR} with env value', () => {
      setEnv('MY_API_KEY', 'sk-secret-123');
      const result = interpolateEnvVars('${MY_API_KEY}');
      expect(result).toBe('sk-secret-123');
    });

    test('replaces ${VAR} inline within a larger string', () => {
      setEnv('API_KEY', 'secret');
      const result = interpolateEnvVars('Bearer ${API_KEY}');
      expect(result).toBe('Bearer secret');
    });

    test('replaces multiple ${VAR} references in one string', () => {
      setEnv('HOST', 'api.example.com');
      setEnv('PORT', '8080');
      const result = interpolateEnvVars('https://${HOST}:${PORT}/v1');
      expect(result).toBe('https://api.example.com:8080/v1');
    });

    test('passes through plain strings without ${...} unchanged', () => {
      const result = interpolateEnvVars('just a plain string');
      expect(result).toBe('just a plain string');
    });

    test('passes through empty string unchanged', () => {
      const result = interpolateEnvVars('');
      expect(result).toBe('');
    });

    test('resolves to empty string when env var is set to empty', () => {
      setEnv('EMPTY_VAR', '');
      const result = interpolateEnvVars('${EMPTY_VAR}');
      expect(result).toBe('');
    });
  });

  describe('missing env vars', () => {
    test('throws with var name when env var is not set', () => {
      clearEnv('DEFINITELY_NOT_SET_XYZ');
      expect(() => interpolateEnvVars('${DEFINITELY_NOT_SET_XYZ}')).toThrow(
        'Config references undefined environment variable(s): DEFINITELY_NOT_SET_XYZ'
      );
    });

    test('throws with path location for nested values', () => {
      clearEnv('MISSING_NESTED');
      expect(() =>
        interpolateEnvVars({ providers: { openrouter: { apiKey: '${MISSING_NESTED}' } } })
      ).toThrow('providers.openrouter.apiKey');
    });

    test('lists all missing vars in one error', () => {
      clearEnv('MISSING_A');
      clearEnv('MISSING_B');
      expect(() => interpolateEnvVars('${MISSING_A} and ${MISSING_B}')).toThrow(
        'MISSING_A, MISSING_B'
      );
    });
  });

  describe('nested structures', () => {
    test('walks nested objects recursively', () => {
      setEnv('PROVIDER_KEY', 'key-123');
      setEnv('PROVIDER_URL', 'https://api.test.com');
      const result = interpolateEnvVars({
        providers: {
          test: {
            apiKey: '${PROVIDER_KEY}',
            baseUrl: '${PROVIDER_URL}',
          },
        },
      }) as Record<string, unknown>;

      const provider = (result.providers as Record<string, unknown>).test as Record<string, unknown>;
      expect(provider.apiKey).toBe('key-123');
      expect(provider.baseUrl).toBe('https://api.test.com');
    });

    test('walks arrays recursively', () => {
      setEnv('MODEL_A', 'gpt-4');
      setEnv('MODEL_B', 'claude-3');
      const result = interpolateEnvVars({ models: ['${MODEL_A}', '${MODEL_B}'] }) as Record<string, unknown>;
      expect(result.models).toEqual(['gpt-4', 'claude-3']);
    });

    test('preserves non-string values (numbers, booleans, null)', () => {
      const result = interpolateEnvVars({
        timeout: 30000,
        enabled: true,
        nothing: null,
      });
      expect(result).toEqual({ timeout: 30000, enabled: true, nothing: null });
    });
  });

  describe('edge cases', () => {
    test('does not interpolate $VAR without braces', () => {
      const result = interpolateEnvVars('$HOME');
      expect(result).toBe('$HOME');
    });

    test('handles ${VAR} at start, middle, and end of string', () => {
      setEnv('PRE', 'start');
      setEnv('MID', 'middle');
      setEnv('SUF', 'end');
      expect(interpolateEnvVars('${PRE}-value')).toBe('start-value');
      expect(interpolateEnvVars('value-${MID}-value')).toBe('value-middle-value');
      expect(interpolateEnvVars('value-${SUF}')).toBe('value-end');
    });

    test('handles deeply nested path in error message', () => {
      clearEnv('DEEP_VAR');
      expect(() =>
        interpolateEnvVars({ a: { b: { c: { d: '${DEEP_VAR}' } } } })
      ).toThrow('a.b.c.d');
    });
  });
});
