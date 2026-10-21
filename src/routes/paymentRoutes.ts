import { Router, Request, Response, NextFunction } from 'express';
import { PaymentService } from '../services/paymentService';
import { paymentSchema, treeifyError } from '../schemas/paymentSchemas';
import { ValidationError } from '../error';
import { responder } from '../responder';

export function paymentRoutes(paymentService: PaymentService): Router {
    const router = Router();

    router.post('/', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const parsed = paymentSchema.safeParse(req.body);
            if (!parsed.success) {
                throw new ValidationError('Invalid payload', treeifyError(parsed.error));
            }

            const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
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

    return router;
}
