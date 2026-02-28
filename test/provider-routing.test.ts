import { expect, test } from 'bun:test';
import {
  buildProviderCompletionUrl,
  getProviderCompletionEndpointPath,
  inferProviderWireFormat
} from '../src/provider-routing.js';

test('infers OpenAI wire format for z.ai paas URL', () => {
  expect(inferProviderWireFormat('https://api.z.ai/api/paas/v4/')).toBe('openai');
  expect(getProviderCompletionEndpointPath('https://api.z.ai/api/paas/v4/')).toBe('/chat/completions');
  expect(buildProviderCompletionUrl('https://api.z.ai/api/paas/v4/')).toBe('https://api.z.ai/api/paas/v4/chat/completions');
});

test('infers Anthropic wire format for /api/anthropic URL', () => {
  expect(inferProviderWireFormat('https://api.z.ai/api/anthropic')).toBe('anthropic');
  expect(getProviderCompletionEndpointPath('https://api.z.ai/api/anthropic')).toBe('/v1/messages');
  expect(buildProviderCompletionUrl('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai/api/anthropic/v1/messages');
});
