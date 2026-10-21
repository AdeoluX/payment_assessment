import { z } from 'zod';

export const paymentSchema = z.object({
    amount: z
        .number()
        .int('Amount must be an integer in minor units (no decimals)')
        .positive('Amount must be greater than 0'),
    currency: z
        .string()
        .trim()
        .length(3, 'Currency must be a 3-letter ISO code')
        .toUpperCase(),
});

export type PaymentInput = z.infer<typeof paymentSchema>;

export function treeifyError(error: z.ZodError) {
    return z.treeifyError(error);
}
