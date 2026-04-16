// ABOUTME: Entry point for llm-fallback-proxy server
// ABOUTME: Loads config, starts Hono server on port 8000, handles graceful shutdown

import { serve } from 'bun';
import { loadConfig, startConfigWatcher, generateConfigSchema, getConfig, getConfigPath } from './config.js';
import { logger } from './logger.js';
import router from './router.js';

const PORT = parseInt(process.env.PORT || '8000', 10);

async function main() {
  try {
    // Load initial config
    await loadConfig();

    // Generate JSON schema for IDE validation
    await generateConfigSchema();

    // Start config watcher for hot-reload
    await startConfigWatcher();

    // Initialize router if any combo uses one
    const { RouterRegistry } = await import('./router-registry.js');
    const routerConfig = getConfig();
    for (const [, combo] of Object.entries(routerConfig.combos)) {
      if ('router' in combo) {
        const configDir = new URL('.', getConfigPath()).pathname;
        await RouterRegistry.getInstance().load(combo.router, configDir);
        break;
      }
    }

    // Start server
    const server = serve({
      port: PORT,
      fetch: router.fetch,
      hostname: '0.0.0.0'
    });

    logger.info(`llm-fallback-proxy started`, {
      port: PORT,
      hostname: '0.0.0.0'
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      server.stop();
      logger.info('Server stopped');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error('Failed to start server', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

main();
