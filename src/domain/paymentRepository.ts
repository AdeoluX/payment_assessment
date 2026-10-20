import { Payment, PaymentStatus } from './payment';
import { CreatePaymentDTO, UpdatePaymentChanges } from '../dtos';

export interface CreatePaymentResult {
    payment: Payment;
    created: boolean;
}

export interface PaymentRepository {
    init(): Promise<void>;
    create(data: CreatePaymentDTO): Promise<CreatePaymentResult>;
    findById(id: string): Promise<Payment | null>;
    findByStatus(status: PaymentStatus): Promise<Payment[]>;
    update(id: string, expectedStatus: PaymentStatus, changes: UpdatePaymentChanges): Promise<Payment>;
}
