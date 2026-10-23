import { z } from 'zod';

export const ISO_4217_CURRENCY_CODES = [
    'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
    'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV',
    'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF',
    'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC', 'CUC', 'CUP', 'CVE',
    'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD',
    'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD',
    'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
    'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD',
    'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL',
    'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN',
    'MXV', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR',
    'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD',
    'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLL',
    'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS',
    'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD',
    'USN', 'UYI', 'UYU', 'UYW', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST',
    'XAF', 'XCD', 'XDR', 'XOF', 'XPF', 'XSU', 'XUA', 'YER', 'ZAR', 'ZMW',
    'ZWL',
] as const;

export const ISO_CURRENCY_SET = new Set<string>(ISO_4217_CURRENCY_CODES);

export const paymentSchema = z.object({
    amount: z.number().superRefine((val, ctx) => {
        if (val <= 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Amount must be greater than 0',
            });
            return;
        }
        if (val > Number.MAX_SAFE_INTEGER || (!Number.isSafeInteger(val) && Number.isInteger(val))) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Amount is too large to store exactly (exceeds MAX_SAFE_INTEGER)',
            });
            return;
        }
        if (!Number.isInteger(val)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Amount must be an integer in minor units (no decimals)',
            });
            return;
        }
    }),
    currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/, 'Currency must consist of exactly 3 alphabetical letters')
        .transform((val) => val.toUpperCase())
        .refine((val) => ISO_CURRENCY_SET.has(val), {
            message: 'Currency must be a valid ISO 4217 currency code (e.g., NGN, USD, EUR, GBP)',
        }),
});

export const idempotencyKeySchema = z
    .string()
    .trim()
    .min(1, 'Idempotency-Key cannot be empty')
    .max(255, 'Idempotency-Key must not exceed 255 characters')
    .regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain only printable ASCII characters without spaces');

export type PaymentInput = z.infer<typeof paymentSchema>;

export const paymentStatusSchema = z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED']);

export const statusEntrySchema = z.object({
    status: paymentStatusSchema,
    at: z.string().min(1, 'History entry timestamp is required'),
});

export const storedPaymentSchema = z.object({
    id: z.string().min(1, 'Payment id is required'),
    amount: z.number().int().positive('Amount must be positive integer'),
    currency: z
        .string()
        .regex(/^[A-Za-z]{3}$/, 'Currency must consist of exactly 3 alphabetical letters')
        .transform((val) => val.toUpperCase())
        .refine((val) => ISO_CURRENCY_SET.has(val), {
            message: 'Currency must be a valid ISO 4217 currency code',
        }),
    idempotencyKey: z.string().max(255).optional(),
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
