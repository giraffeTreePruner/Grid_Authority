/**
 * Entry point for the read-only JSON API.
 */
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

export const API_VERSION = 'v1' as const;

const main = async (): Promise<void> => {
  const env = loadEnv();
  const { app } = await buildApp({ env });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
};

// Only start a server when run directly, so importing this module in a test does not.
if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
