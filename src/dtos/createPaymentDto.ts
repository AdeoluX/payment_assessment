export interface CreatePaymentDTO {
    amount: number;
    currency: string;
    idempotencyKey?: string;
}
