import { Response } from 'express';
import { AppError } from './error';

export interface SuccessBody<T> {
    success: true;
    data: T;
    meta?: Record<string, unknown>;
}

export interface ErrorBody {
    success: false;
    error: { code: string; message: string; details?: unknown };
}

export const responder = {
    ok<T>(res: Response, data: T, meta?: Record<string, unknown>) {
        const body: SuccessBody<T> = { success: true, data, ...(meta && { meta }) };
        return res.status(200).json(body);
    },

    created<T>(res: Response, data: T) {
        const body: SuccessBody<T> = { success: true, data };
        return res.status(201).json(body);
    },

    fail(res: Response, err: AppError) {
        const body: ErrorBody = {
            success: false,
            error: { code: err.code, message: err.message, details: err.details },
        };
        return res.status(err.statusCode).json(body);
    },

    internal(res: Response, message = 'Internal server error') {
        const body: ErrorBody = {
            success: false,
            error: { code: 'INTERNAL_ERROR', message },
        };
        return res.status(500).json(body);
    },
};