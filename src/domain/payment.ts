export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';

export interface StatusEntry { status: PaymentStatus; at: string }

export interface Payment {
    id: string;
    //must be kobo the minor units
    amount: number;
    currency: string;
    idempotencyKey?: string;
    status: PaymentStatus;
    failureReason?: string;
    history: StatusEntry[];
    createdAt: string;
    updatedAt: string;
}