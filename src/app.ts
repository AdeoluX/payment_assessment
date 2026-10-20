import express, { NextFunction, Request, Response } from 'express'
import { AppError, NotFoundError, ValidationError } from './error'
import { responder } from './responder'

export function createApp() {
    const app = express();
    app.use(express.json({ limit: '10kb' }))
    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok' })
    })

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