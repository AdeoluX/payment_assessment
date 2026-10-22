import { PaymentRepository } from '../domain/paymentRepository';
import { PaymentInput, UpdateStatusInput } from '../schemas/paymentSchemas';
import { UpdatePaymentChanges } from '../dtos';
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

    async updateStatus(id: string, input: UpdateStatusInput) {
        let expectedStatus = input.expectedStatus;
        if (!expectedStatus) {
            const current = await this.get(id);
            expectedStatus = current.status;
        }

        const changes: UpdatePaymentChanges =
            input.status === 'FAILED'
                ? { status: 'FAILED', failureReason: input.failureReason! }
                : { status: input.status };

        return this.paymentRepo.update(id, expectedStatus, changes);
    }
}
