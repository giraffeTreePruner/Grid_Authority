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

// This module exists only to start the server, and nothing imports it: the tests build
// their own instance from app.ts. So it starts unconditionally.
//
// It previously guarded on process.argv[1] ending in index.js, which looks harmless and
// is not: PM2 loads the app through its own process container, so argv[1] is PM2's file
// and main() never ran. The API reported healthy under PM2 while listening on nothing.
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
