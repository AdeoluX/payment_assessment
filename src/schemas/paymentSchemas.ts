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

export const paymentStatusSchema = z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED']);

export const statusEntrySchema = z.object({
    status: paymentStatusSchema,
    at: z.string().min(1, 'History entry timestamp is required'),
});

export const storedPaymentSchema = z.object({
    id: z.string().min(1, 'Payment id is required'),
    amount: z.number().int().positive('Amount must be positive integer'),
    currency: z.string().length(3, 'Currency must be 3 characters'),
    idempotencyKey: z.string().optional(),
    status: paymentStatusSchema,
    failureReason: z.string().optional(),
    history: z.array(statusEntrySchema).min(1, 'History must have at least one entry'),
    createdAt: z.string().min(1, 'createdAt is required'),
    updatedAt: z.string().min(1, 'updatedAt is required'),
});

export const storedPaymentsFileSchema = z.array(storedPaymentSchema);

export const updateStatusSchema = z
    .object({
        status: paymentStatusSchema,
        failureReason: z.string().trim().optional(),
        expectedStatus: paymentStatusSchema.optional(),
    })
    .superRefine((data, ctx) => {
        if (data.status === 'FAILED') {
            if (!data.failureReason || data.failureReason.length === 0) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['failureReason'],
                    message: "failureReason is required when status is 'FAILED'",
                });
            }
        } else if (data.failureReason !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['failureReason'],
                message: `failureReason cannot be set when status is '${data.status}'`,
            });
        }
    });

export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;

export function treeifyError(error: z.ZodError) {
    return z.treeifyError(error);
}
