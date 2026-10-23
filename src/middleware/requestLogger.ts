import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

const httpLogger = logger.child('HTTP');

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();

    res.on('finish', () => {
        const durationMs = Date.now() - startTime;
        const meta: Record<string, unknown> = {
            method: req.method,
            path: req.originalUrl || req.url,
            statusCode: res.statusCode,
            durationMs,
        };

        const idempotencyKey = req.headers['idempotency-key'];
        if (idempotencyKey && typeof idempotencyKey === 'string') {
            meta.idempotencyKey = idempotencyKey;
        }

        httpLogger.info(`${req.method} ${req.originalUrl || req.url} ${res.statusCode} (${durationMs}ms)`, meta);
    });

    next();
}
