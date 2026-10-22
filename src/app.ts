import express, { NextFunction, Request, Response } from 'express'
import { AppError, NotFoundError, ValidationError } from './error'
import { paymentRoutes } from './routes/paymentRoutes'
import { responder } from './responder'
import { PaymentService } from './services/paymentService';
import { PaymentRepository } from './domain/paymentRepository';

export function createApp(repo: PaymentRepository, adminApiKey?: string) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '10kb' }))
    app.get('/health', async (_req: Request, res: Response) => {
        const isReady = await repo.isReady();
        if (!isReady) {
            return res.status(503).json({
                status: 'error',
                store: 'unready',
            });
        }

        return res.status(200).json({
            status: 'ok',
            store: 'ready',
        });
    });

    app.use('/payments', paymentRoutes(new PaymentService(repo), adminApiKey))

    app.use((_req: Request, _res: Response, next: NextFunction) => {
        next(new NotFoundError('Route not found'))
    })

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        if (err instanceof AppError) return responder.fail(res, err)
        console.error(err)
        res.status(500).json({
            error: {
                code: 'INTERNAL_ERROR', message: 'Internal server error'
            }
        })
    })

    return app;
}