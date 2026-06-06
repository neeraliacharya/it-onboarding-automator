/**
 * api/server.ts
 *
 * Express application factory + entry point.
 *
 * createApp() is exported so tests can import the app without starting a
 * real TCP listener (supertest handles that).  The listen() call only runs
 * when this file is the Node.js entry point (node dist/api/server.js).
 */

import 'dotenv/config';
import express, { Application } from 'express';
import webhookRouter from './webhook';
import { logger } from '../onboarding/logger';

export function createApp(): Application {
  const app = express();

  // Parse JSON bodies (built into Express 4.16+).
  app.use(express.json());

  // Mount routers.
  app.use('/webhooks', webhookRouter);

  return app;
}

// Only start listening when run as the main entry point.
// This guard ensures tests never accidentally bind to a port.
if (require.main === module) {
  const app = createApp();
  const PORT = parseInt(process.env.PORT ?? '3000', 10);

  app.listen(PORT, () => {
    logger.info('Server started', {
      port: PORT,
      log_level: process.env.LOG_LEVEL ?? 'info',
    });
  });
}
