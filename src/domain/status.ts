import { PaymentStatus } from './payment';
import { ConflictError } from '../error'

export const allowedTransitions: Record<PaymentStatus, PaymentStatus[]> = {
    PENDING: ['PROCESSING'],
    PROCESSING: ['SUCCESS', 'FAILED'],
    SUCCESS: [],
    FAILED: [],
} as const;

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
    const allowed = allowedTransitions[from];
    if (!allowed.includes(to)) {
        throw new ConflictError(`Cannot move payment status from ${from} to ${to}`)
    }
}

export function isTerminal(status: PaymentStatus) {
    return allowedTransitions[status].length === 0;
}