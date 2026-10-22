import { PaymentStatus } from '../domain/payment';

export type UpdatePaymentChanges =
    | { status: 'FAILED'; failureReason: string }
    | { status: Exclude<PaymentStatus, 'FAILED'>; failureReason?: never };

export interface UpdatePaymentDTO {
    id: string;
    expectedStatus: PaymentStatus;
    changes: UpdatePaymentChanges;
}
