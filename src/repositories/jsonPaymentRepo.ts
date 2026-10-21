import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Payment, PaymentStatus } from '../domain/payment';
import { PaymentRepository, CreatePaymentResult } from '../domain/paymentRepository';
import { CreatePaymentDTO, UpdatePaymentChanges } from '../dtos';
import { assertTransition } from '../domain/status';
import { ConflictError, NotFoundError } from '../error';

class PromiseQueue {
    private tail: Promise<unknown> = Promise.resolve();

    enqueue<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.tail = this.tail
                .then(async () => {
                    try {
                        const result = await task();
                        resolve(result);
                    } catch (err) {
                        reject(err);
                    }
                })
                .catch(() => {
                    // Prevent a failed task from poisoning subsequent queued operations
                });
        });
    }
}

export class JsonPaymentRepo implements PaymentRepository {
    private readonly filePath: string;
    private readonly memoryStore = new Map<string, Payment>();
    private readonly idempotencyIndex = new Map<string, Payment>();
    private readonly writeQueue = new PromiseQueue();
    private isInitialized = false;

    constructor(filePath: string = './data/payments.json') {
        this.filePath = path.resolve(process.cwd(), filePath);
    }

    async init(): Promise<void> {
        await this.ensureInitialized();
    }

    private async ensureInitialized(): Promise<void> {
        if (this.isInitialized) return;

        const dir = path.dirname(this.filePath);
        await fs.mkdir(dir, { recursive: true });

        try {
            const raw = await fs.readFile(this.filePath, 'utf-8');
            const payments: Payment[] = JSON.parse(raw);
            this.memoryStore.clear();
            this.idempotencyIndex.clear();
            for (const payment of payments) {
                this.memoryStore.set(payment.id, payment);
                if (payment.idempotencyKey) {
                    this.idempotencyIndex.set(payment.idempotencyKey, payment);
                }
            }
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                await this.persist([]);
            } else {
                throw err;
            }
        }

        this.isInitialized = true;
    }

    private async persist(payments: Payment[]): Promise<void> {
        const tempPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(payments, null, 2), 'utf-8');
        await fs.rename(tempPath, this.filePath);
    }

    async create(data: CreatePaymentDTO): Promise<CreatePaymentResult> {
        await this.ensureInitialized();

        return this.writeQueue.enqueue(async () => {
            // O(1) Idempotency lookup via secondary index hashmap
            if (data.idempotencyKey) {
                const existing = this.idempotencyIndex.get(data.idempotencyKey);
                if (existing) {
                    return { payment: existing, created: false };
                }
            }

            const now = new Date().toISOString();
            const payment: Payment = {
                id: crypto.randomUUID(),
                amount: data.amount,
                currency: data.currency,
                idempotencyKey: data.idempotencyKey,
                status: 'PENDING',
                history: [{ status: 'PENDING', at: now }],
                createdAt: now,
                updatedAt: now,
            };

            // Write to disk first
            const nextPayments = [...this.memoryStore.values(), payment];
            await this.persist(nextPayments);

            // Commit to memory store and index ONLY after disk write succeeds
            this.memoryStore.set(payment.id, payment);
            if (payment.idempotencyKey) {
                this.idempotencyIndex.set(payment.idempotencyKey, payment);
            }

            return { payment, created: true };
        });
    }

    async findById(id: string): Promise<Payment | null> {
        await this.ensureInitialized();
        return this.memoryStore.get(id) ?? null;
    }

    async findByStatus(status: PaymentStatus): Promise<Payment[]> {
        await this.ensureInitialized();
        return Array.from(this.memoryStore.values()).filter(p => p.status === status);
    }

    async update(id: string, expectedStatus: PaymentStatus, changes: UpdatePaymentChanges): Promise<Payment> {
        await this.ensureInitialized();

        return this.writeQueue.enqueue(async () => {
            const payment = this.memoryStore.get(id);
            if (!payment) {
                throw new NotFoundError(`Payment with ID ${id} not found`);
            }

            // 1. Conflict check: reject if current status doesn't match expectedStatus
            if (payment.status !== expectedStatus) {
                throw new ConflictError(
                    `Payment status mismatch. Expected '${expectedStatus}', but current status is '${payment.status}'`,
                    { expected: expectedStatus, actual: payment.status }
                );
            }

            // 2. State transition check: assert legal transition
            assertTransition(payment.status, changes.status);

            // 3. Create updated immutable copy (do not mutate memoryStore yet)
            const now = new Date().toISOString();
            const updatedPayment: Payment = {
                ...payment,
                status: changes.status,
                history: [...payment.history, { status: changes.status, at: now }],
                failureReason: changes.failureReason !== undefined ? changes.failureReason : payment.failureReason,
                updatedAt: now,
            };

            // 4. Write to disk first
            const nextPayments = Array.from(this.memoryStore.values()).map(p =>
                p.id === id ? updatedPayment : p
            );
            await this.persist(nextPayments);

            // 5. Commit to memory store and index ONLY after disk write succeeds
            this.memoryStore.set(id, updatedPayment);
            if (updatedPayment.idempotencyKey) {
                this.idempotencyIndex.set(updatedPayment.idempotencyKey, updatedPayment);
            }

            return updatedPayment;
        });
    }
}
