import { createBuilder } from 'standard-config-schema';
import { z } from 'zod';

type ServerVariantBase = { type: string };

type ServerHooks = {
  validate: { input: { raw: unknown }; output: { config: unknown } };
};

const builder = createBuilder<ServerVariantBase, ServerHooks>(['validate']);

export const serverBuilder = builder({
  stdio: { type: 'stdio', command: '', args: [], env: {} },
  http: { type: 'http', url: '' },
});

const StdioSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const HttpSchema = z.object({
  type: z.literal('http'),
  url: z.url(),
});

export const ServerSchema = z.discriminatedUnion('type', [StdioSchema, HttpSchema]);
export type ServerConfig = z.infer<typeof ServerSchema>;
