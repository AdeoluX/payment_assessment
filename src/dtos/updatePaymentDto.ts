import { PaymentStatus } from '../domain/payment';

export interface UpdatePaymentChanges {
    status: PaymentStatus;
    failureReason?: string;
}

export interface UpdatePaymentDTO {
    id: string;
    expectedStatus: PaymentStatus;
    changes: UpdatePaymentChanges;
}
