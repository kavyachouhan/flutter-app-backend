/**
 * `GET /v1/openapi.json` and the Swagger UI at `GET /v1/docs`.
 *
 * Unauthenticated on purpose: the document contains no tenant data, and the
 * clients' build pipelines fetch it without credentials. It is still gated by
 * `OPENAPI_ENABLED` so a production deployment can hide it.
 */
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './document.js';

export function createOpenApiRouter(): Router {
  const router = Router();

  router.get('/openapi.json', (_req, res) => {
    // Generated once per process; cheap to serve, safe to cache at the edge.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(buildOpenApiDocument());
  });

  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(buildOpenApiDocument(), {
      customSiteTitle: 'Khata API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );

  return router;
}
