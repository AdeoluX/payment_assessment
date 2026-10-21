import { PaymentRepository } from '../domain/paymentRepository';
import { PaymentInput } from '../schemas/paymentSchemas';
import { NotFoundError } from '../error';

export class PaymentService {
    constructor(private readonly paymentRepo: PaymentRepository) { }

    async create(input: PaymentInput, idempotencyKey?: string) {
        return this.paymentRepo.create({ ...input, idempotencyKey });
    }

    async get(id: string) {
        const payment = await this.paymentRepo.findById(id);
        if (!payment) {
            throw new NotFoundError(`Payment with ID ${id} not found`);
        }
        return payment;
    }
}
