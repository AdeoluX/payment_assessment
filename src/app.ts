import express, { NextFunction, Request, Response } from 'express'
import { AppError, BadRequestError, NotFoundError, PayloadTooLargeError } from './error'
import { paymentRoutes } from './routes/paymentRoutes'
import { responder } from './responder'
import { PaymentService } from './services/paymentService';
import { PaymentRepository } from './domain/paymentRepository';
import { requestLogger } from './middleware/requestLogger';
import { logger } from './logger';

export function createApp(repo: PaymentRepository, adminApiKey?: string) {
    const app = express();
    app.disable('x-powered-by');
    app.use(requestLogger);
    app.use(express.json({ limit: '10kb' }))
    app.get('/health', async (_req: Request, res: Response) => {
        const isReady = await repo.isReady();
        if (!isReady) {
            return res.status(503).json({
                success: false,
                error: {
                    code: 'SERVICE_UNAVAILABLE',
                    message: 'Storage is unready or unwritable',
                    details: {
                        status: 'error',
                        store: 'unready',
                    },
                },
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                status: 'ok',
                store: 'ready',
            },
        });
    });

    app.use('/payments', paymentRoutes(new PaymentService(repo), adminApiKey))

    app.use((_req: Request, _res: Response, next: NextFunction) => {
        next(new NotFoundError('Route not found'))
    })

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
        if (err instanceof AppError) {
            return responder.fail(res, err);
        }

        // Handle body-parser entity too large (payload > 10kb)
        if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
            return responder.fail(
                res,
                new PayloadTooLargeError('Payload too large. Maximum allowed size is 10kb.')
            );
        }

        // Handle body-parser malformed JSON syntax errors (e.g., '{bad')
        if (
            (err instanceof SyntaxError && 'body' in err) ||
            err.type === 'entity.parse.failed' ||
            ((err.status === 400 || err.statusCode === 400) && err instanceof SyntaxError)
        ) {
            return responder.fail(
                res,
                new BadRequestError('Invalid JSON syntax in request body', undefined, 'INVALID_JSON')
            );
        }

        logger.error('Unhandled internal server error', err);
        return responder.internal(res);
    })

    return app;
}