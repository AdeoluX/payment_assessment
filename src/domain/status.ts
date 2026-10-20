import { PaymentStatus } from './payment';

export const allowedTransitions: Record<PaymentStatus, PaymentStatus[]> = {
    PENDING: ['PROCESSING'],
    PROCESSING: ['SUCCESS', 'FAILED'],
    SUCCESS: [],
    FAILED: [],
};