import { Router, Request, Response, NextFunction } from 'express';
import { PaymentService } from '../services/paymentService';
import {
    paymentSchema,
    updateStatusSchema,
    idempotencyKeySchema,
    treeifyError,
} from '../schemas/paymentSchemas';
import { ValidationError } from '../error';
import { responder } from '../responder';
import { requireAdminAuth } from '../middleware/authMiddleware';

export function paymentRoutes(paymentService: PaymentService, adminApiKey?: string): Router {
    const router = Router();

    router.post('/', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const parsed = paymentSchema.safeParse(req.body);
            if (!parsed.success) {
                throw new ValidationError('Invalid payload', treeifyError(parsed.error));
            }

            const rawIdempotencyKey = req.headers['idempotency-key'];
            let idempotencyKey: string | undefined;

            if (rawIdempotencyKey !== undefined) {
                if (Array.isArray(rawIdempotencyKey)) {
                    throw new ValidationError('Multiple Idempotency-Key headers are not allowed');
                }
                const parsedKey = idempotencyKeySchema.safeParse(rawIdempotencyKey);
                if (!parsedKey.success) {
                    throw new ValidationError(
                        'Invalid Idempotency-Key header',
                        treeifyError(parsedKey.error)
                    );
                }
                idempotencyKey = parsedKey.data;
            }

            const result = await paymentService.create(parsed.data, idempotencyKey);

            if (result.created) {
                return responder.created(res, result.payment);
            }
            return responder.ok(res, result.payment);
        } catch (err) {
            next(err);
        }
    });

    router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const payment = await paymentService.get(req.params.id as string);
            return responder.ok(res, payment);
        } catch (err) {
            next(err);
        }
    });

    const handleUpdateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const parsed = updateStatusSchema.safeParse(req.body);
            if (!parsed.success) {
                throw new ValidationError('Invalid payload', treeifyError(parsed.error));
            }

            const updated = await paymentService.updateStatus(req.params.id as string, parsed.data);
            return responder.ok(res, updated);
        } catch (err) {
            next(err);
        }
    };

    const adminAuth = requireAdminAuth(adminApiKey);
    router.patch('/:id/status', adminAuth, handleUpdateStatus);
    router.put('/:id/status', adminAuth, handleUpdateStatus);

    return router;
}
