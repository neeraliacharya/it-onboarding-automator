/**
 * api/webhook.ts
 *
 * Express router for POST /webhooks/hris.
 * Delegates all business logic to onboarding/provisioner.ts — no grant
 * logic lives here (CLAUDE.md rule).
 */

import { Router, Request, Response } from 'express';
import {
  provisionEmployee,
  ProvisioningHttpError,
} from '../onboarding/provisioner';
import { logger } from '../onboarding/logger';
import type { WebhookPayload } from '../onboarding/types';

const router = Router();

router.post('/hris', (req: Request, res: Response): void => {
  const payload = req.body as WebhookPayload;

  logger.debug('Incoming webhook request', {
    method: req.method,
    path: req.path,
    event_id: (payload as unknown as Record<string, unknown>).event_id,
  });

  try {
    const result = provisionEmployee(payload);

    logger.info('Webhook accepted', {
      event_id: result.event_id,
      idempotent: result.idempotent,
    });

    res.status(202).json(result);
  } catch (err) {
    if (err instanceof ProvisioningHttpError) {
      logger.warn('Webhook rejected', {
        event_id: err.eventId,
        error: err.errorCode,
        status: err.statusCode,
      });

      // 409 for in-flight conflict, 400 for all other known errors.
      res.status(err.statusCode).json({
        event_id: err.eventId,
        error: err.errorCode,
        message: err.message,
      });
      return;
    }

    // Unexpected error — never leak stack traces.
    logger.error('Unexpected error in webhook handler', {
      error: (err as Error).message,
    });
    res.status(500).json({
      error: 'internal_error',
      message: 'An unexpected error occurred.',
    });
  }
});

export default router;
