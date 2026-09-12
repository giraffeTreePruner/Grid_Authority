/**
 * GET /zones — the registry as the map and the zone list consume it.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../lib/db.js';
import { buildMeta, latestDataPeriod } from '../lib/meta.js';

interface ZoneRow {
  key: string;
  name: string;
  short_name: string;
  interconnection: string | null;
  type: string;
  in_map: boolean;
  capabilities: Record<string, boolean>;
}

export const zoneRoutes = (app: FastifyInstance, sql: Sql): void => {
  app.get('/zones', async (_request, reply) => {
    const [zones, latest] = await Promise.all([
      sql<ZoneRow[]>`
        SELECT key, name, short_name, interconnection, type, in_map, capabilities
          FROM zones
         ORDER BY key
      `,
      latestDataPeriod(sql),
    ]);

    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send({ zones, meta: buildMeta(latest) });
  });
};
