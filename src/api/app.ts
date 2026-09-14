import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true }));

  // TODO: register batches routes (create/list/get/cancel/retry) here,
  // ported from URL-Checker-Backend/apps/api/src/routes/batches.ts

  return app;
}
