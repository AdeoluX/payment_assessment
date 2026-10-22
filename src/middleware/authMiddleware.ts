import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { UnauthorizedError } from '../error';

export function requireAdminAuth(configuredKey?: string) {
    const key = configuredKey || process.env.ADMIN_API_KEY;
    if (!key || key.trim() === '') {
        throw new Error("Fatal: Required environment variable 'ADMIN_API_KEY' is unset.");
    }

    const expectedDigest = crypto.createHash('sha256').update(key).digest();

    return (req: Request, _res: Response, next: NextFunction) => {
        // Accept ONLY the X-Admin-Api-Key header (Express normalizes headers to lowercase)
        const providedKey = req.headers['x-admin-api-key'];

        if (typeof providedKey !== 'string' || providedKey.trim() === '') {
            console.warn(
                `Unauthorized status update attempt on ${req.method} ${req.originalUrl || req.url}: missing or empty X-Admin-Api-Key header`
            );
            throw new UnauthorizedError('Missing or invalid admin API key');
        }

        const providedDigest = crypto.createHash('sha256').update(providedKey).digest();

        if (!crypto.timingSafeEqual(providedDigest, expectedDigest)) {
            console.warn(
                `Unauthorized status update attempt on ${req.method} ${req.originalUrl || req.url}: incorrect X-Admin-Api-Key`
            );
            throw new UnauthorizedError('Missing or invalid admin API key');
        }

        next();
    };
}
