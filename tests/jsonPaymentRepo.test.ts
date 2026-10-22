import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonPaymentRepo } from '../src/repositories/jsonPaymentRepo';
import { ConflictError, NotFoundError, ValidationError } from '../src/error';

describe('JsonPaymentRepo', () => {
    let testFilePath: string;
    let repo: JsonPaymentRepo;

    beforeEach(async () => {
        const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        testFilePath = path.join(os.tmpdir(), `payments-test-${uniqueId}.json`);
        repo = new JsonPaymentRepo(testFilePath);
        await repo.init();
    });

    afterEach(async () => {
        await fs.rm(testFilePath, { force: true }).catch(() => {});
    });

    describe('Initialization', () => {
        it('should create an empty array in storage file if it does not exist', async () => {
            const raw = await fs.readFile(testFilePath, 'utf-8');
            expect(JSON.parse(raw)).toEqual([]);
        });

        it('should refuse to initialize on invalid JSON syntax (corrupted file)', async () => {
            await fs.writeFile(testFilePath, '{"invalid_json_truncated":', 'utf-8');

            const corruptRepo = new JsonPaymentRepo(testFilePath);
            await expect(corruptRepo.init()).rejects.toThrow(/invalid JSON syntax/i);
        });

        it('should refuse to initialize on valid JSON that is not an array', async () => {
            await fs.writeFile(testFilePath, JSON.stringify({ notAnArray: true }), 'utf-8');

            const corruptRepo = new JsonPaymentRepo(testFilePath);
            await expect(corruptRepo.init()).rejects.toThrow(/schema validation failed/i);
        });

        it('should refuse to initialize on array with invalid payment record schema (e.g. invalid status)', async () => {
            const invalidPayment = {
                id: '123',
                amount: 5000,
                currency: 'NGN',
                status: 'INVALID_STATUS_ENUM', // invalid status
                history: [{ status: 'INVALID_STATUS_ENUM', at: '2026-10-22T00:00:00Z' }],
                createdAt: '2026-10-22T00:00:00Z',
                updatedAt: '2026-10-22T00:00:00Z',
            };
            await fs.writeFile(testFilePath, JSON.stringify([invalidPayment]), 'utf-8');

            const corruptRepo = new JsonPaymentRepo(testFilePath);
            await expect(corruptRepo.init()).rejects.toThrow(/schema validation failed/i);
        });
    });

    describe('create()', () => {
        it('should create a payment with initial PENDING status and history', async () => {
            const result = await repo.create({
                amount: 5000,
                currency: 'NGN',
                idempotencyKey: 'idemp-1',
            });

            expect(result.created).toBe(true);
            expect(result.payment.id).toBeDefined();
            expect(result.payment.amount).toBe(5000);
            expect(result.payment.currency).toBe('NGN');
            expect(result.payment.status).toBe('PENDING');
            expect(result.payment.history).toHaveLength(1);
            expect(result.payment.history[0].status).toBe('PENDING');
            expect(result.payment.createdAt).toBeDefined();
            expect(result.payment.updatedAt).toBeDefined();

            // Verify disk persistence
            const onDisk = JSON.parse(await fs.readFile(testFilePath, 'utf-8'));
            expect(onDisk).toHaveLength(1);
            expect(onDisk[0].id).toBe(result.payment.id);
        });

        it('should return existing payment with created=false on identical idempotency key replay', async () => {
            const first = await repo.create({
                amount: 5000,
                currency: 'NGN',
                idempotencyKey: 'key-replay',
            });
            expect(first.created).toBe(true);

            const second = await repo.create({
                amount: 5000,
                currency: 'NGN',
                idempotencyKey: 'key-replay',
            });

            expect(second.created).toBe(false);
            expect(second.payment.id).toBe(first.payment.id);

            const onDisk = JSON.parse(await fs.readFile(testFilePath, 'utf-8'));
            expect(onDisk).toHaveLength(1);
        });

        it('should throw ConflictError if idempotency key is reused with different amount', async () => {
            await repo.create({
                amount: 5000,
                currency: 'NGN',
                idempotencyKey: 'conflict-amount',
            });

            await expect(
                repo.create({
                    amount: 9000,
                    currency: 'NGN',
                    idempotencyKey: 'conflict-amount',
                })
            ).rejects.toThrow(ConflictError);
        });

        it('should throw ConflictError if idempotency key is reused with different currency', async () => {
            await repo.create({
                amount: 5000,
                currency: 'NGN',
                idempotencyKey: 'conflict-currency',
            });

            await expect(
                repo.create({
                    amount: 5000,
                    currency: 'USD',
                    idempotencyKey: 'conflict-currency',
                })
            ).rejects.toThrow(ConflictError);
        });
    });

    describe('findById()', () => {
        it('should return payment by ID', async () => {
            const { payment } = await repo.create({ amount: 2000, currency: 'USD' });
            const found = await repo.findById(payment.id);
            expect(found).not.toBeNull();
            expect(found?.id).toBe(payment.id);
        });

        it('should return null for non-existent ID', async () => {
            const found = await repo.findById('non-existent-id');
            expect(found).toBeNull();
        });
    });

    describe('findByStatus()', () => {
        it('should filter payments and sort oldest first by createdAt', async () => {
            const first = await repo.create({ amount: 1000, currency: 'NGN' });
            // Small pause to guarantee different timestamps
            await new Promise(r => setTimeout(r, 10));
            const second = await repo.create({ amount: 2000, currency: 'NGN' });

            const results = await repo.findByStatus('PENDING');
            expect(results).toHaveLength(2);
            expect(results[0].id).toBe(first.payment.id);
            expect(results[1].id).toBe(second.payment.id);
            expect(new Date(results[0].createdAt).getTime()).toBeLessThanOrEqual(
                new Date(results[1].createdAt).getTime()
            );
        });
    });

    describe('update()', () => {
        it('should transition status from PENDING to PROCESSING and append history', async () => {
            const { payment } = await repo.create({ amount: 1000, currency: 'NGN' });

            const updated = await repo.update(payment.id, 'PENDING', { status: 'PROCESSING' });

            expect(updated.status).toBe('PROCESSING');
            expect(updated.history).toHaveLength(2);
            expect(updated.history[0].status).toBe('PENDING');
            expect(updated.history[1].status).toBe('PROCESSING');
        });

        it('should throw NotFoundError if payment ID is not found', async () => {
            await expect(
                repo.update('missing-id', 'PENDING', { status: 'PROCESSING' })
            ).rejects.toThrow(NotFoundError);
        });

        it('should throw ConflictError if expectedStatus does not match current status (optimistic lock)', async () => {
            const { payment } = await repo.create({ amount: 1000, currency: 'NGN' });

            await expect(
                repo.update(payment.id, 'PROCESSING', { status: 'SUCCESS' })
            ).rejects.toThrow(ConflictError);
        });

        it('should throw ConflictError on invalid state transition (PENDING -> SUCCESS)', async () => {
            const { payment } = await repo.create({ amount: 1000, currency: 'NGN' });

            await expect(
                repo.update(payment.id, 'PENDING', { status: 'SUCCESS' })
            ).rejects.toThrow(ConflictError);
        });

        it('should require failureReason when status is FAILED', async () => {
            const { payment } = await repo.create({ amount: 1000, currency: 'NGN' });
            await repo.update(payment.id, 'PENDING', { status: 'PROCESSING' });

            await expect(
                repo.update(payment.id, 'PROCESSING', { status: 'FAILED' } as any)
            ).rejects.toThrow(ValidationError);
        });

        it('should update to FAILED when valid failureReason is provided', async () => {
            const { payment } = await repo.create({ amount: 1000, currency: 'NGN' });
            await repo.update(payment.id, 'PENDING', { status: 'PROCESSING' });

            const failed = await repo.update(payment.id, 'PROCESSING', {
                status: 'FAILED',
                failureReason: 'Insufficient funds',
            });

            expect(failed.status).toBe('FAILED');
            expect(failed.failureReason).toBe('Insufficient funds');
        });

        it('should reject failureReason when status is not FAILED', async () => {
            const { payment } = await repo.create({ amount: 1000, currency: 'NGN' });

            await expect(
                repo.update(payment.id, 'PENDING', {
                    status: 'PROCESSING',
                    failureReason: 'Not allowed',
                } as any)
            ).rejects.toThrow(ValidationError);
        });
    });

    describe('Concurrency and Queueing', () => {
        it('should process concurrent writes cleanly through the PromiseQueue without file corruption', async () => {
            const writes = Array.from({ length: 10 }, (_, i) =>
                repo.create({
                    amount: 1000 + i,
                    currency: 'NGN',
                    idempotencyKey: `concurrent-${i}`,
                })
            );

            const results = await Promise.all(writes);
            expect(results).toHaveLength(10);

            const onDisk = JSON.parse(await fs.readFile(testFilePath, 'utf-8'));
            expect(onDisk).toHaveLength(10);
        });

        it('should create exactly one payment for 20 parallel requests with the same idempotency key (same-key race)', async () => {
            const raceKey = 'race-key-20-workers';

            // Fire 20 parallel requests at the exact same instant
            const parallelRequests = Array.from({ length: 20 }, () =>
                repo.create({
                    amount: 5000,
                    currency: 'NGN',
                    idempotencyKey: raceKey,
                })
            );

            const results = await Promise.all(parallelRequests);

            // Exactly 1 request should have created: true
            const createdResults = results.filter(r => r.created === true);
            const replayedResults = results.filter(r => r.created === false);

            expect(createdResults).toHaveLength(1);
            expect(replayedResults).toHaveLength(19);

            // All 20 results must reference the exact same payment ID
            const originalPaymentId = createdResults[0].payment.id;
            for (const res of results) {
                expect(res.payment.id).toBe(originalPaymentId);
            }

            // Disk storage must contain exactly 1 record
            const onDisk = JSON.parse(await fs.readFile(testFilePath, 'utf-8'));
            expect(onDisk).toHaveLength(1);
            expect(onDisk[0].id).toBe(originalPaymentId);
            expect(onDisk[0].idempotencyKey).toBe(raceKey);
        });

        it('should allow exactly one worker to transition a payment among multiple concurrent workers (CAS race)', async () => {
            // 1. Seed a payment in PENDING state
            const { payment } = await repo.create({ amount: 10000, currency: 'USD' });

            // 2. 10 workers concurrently attempt to advance PENDING -> PROCESSING
            const workerAttempts = Array.from({ length: 10 }, () =>
                repo.update(payment.id, 'PENDING', { status: 'PROCESSING' })
                    .then(res => ({ success: true, payment: res, error: null }))
                    .catch(err => ({ success: false, payment: null, error: err }))
            );

            const outcomes = await Promise.all(workerAttempts);

            const successfulWorkers = outcomes.filter(o => o.success);
            const failedWorkers = outcomes.filter(o => !o.success);

            // Exactly 1 worker must succeed
            expect(successfulWorkers).toHaveLength(1);
            expect(successfulWorkers[0].payment?.status).toBe('PROCESSING');

            // The other 9 workers must be rejected with ConflictError
            expect(failedWorkers).toHaveLength(9);
            for (const fail of failedWorkers) {
                expect(fail.error).toBeInstanceOf(ConflictError);
            }

            // On-disk verification
            const onDisk = JSON.parse(await fs.readFile(testFilePath, 'utf-8'));
            expect(onDisk).toHaveLength(1);
            expect(onDisk[0].status).toBe('PROCESSING');
            expect(onDisk[0].history).toHaveLength(2);
        });
    });

    describe('Disk Failure Resilience & Queue Recovery', () => {
        it('should not corrupt memory store or disk on failed write, and allow subsequent writes to succeed', async () => {
            // 1. Initial successful payment
            await repo.create({ amount: 1000, currency: 'NGN', idempotencyKey: 'initial' });

            // 2. Mock a disk failure on writeFile
            const spy = jest.spyOn(fs, 'writeFile').mockImplementationOnce(async () => {
                throw new Error('ENOSPC: no space left on device');
            });

            // 3. Attempt a write that fails at disk level
            await expect(
                repo.create({ amount: 9999, currency: 'NGN', idempotencyKey: 'failed-key' })
            ).rejects.toThrow('ENOSPC: no space left on device');

            spy.mockRestore();

            // 4. Memory store check: phantom record must NOT exist
            const paymentsInMemory = await repo.findByStatus('PENDING');
            expect(paymentsInMemory).toHaveLength(1);
            expect(paymentsInMemory[0].idempotencyKey).toBe('initial');

            // 5. Disk file check: must still be valid JSON and contain only initial payment
            const onDisk = JSON.parse(await fs.readFile(testFilePath, 'utf-8'));
            expect(onDisk).toHaveLength(1);
            expect(onDisk[0].idempotencyKey).toBe('initial');

            // 6. Queue recovery check: subsequent writes must succeed!
            const subsequent = await repo.create({
                amount: 2000,
                currency: 'NGN',
                idempotencyKey: 'after-failure',
            });

            expect(subsequent.created).toBe(true);
            expect(subsequent.payment.amount).toBe(2000);

            const finalOnDisk = JSON.parse(await fs.readFile(testFilePath, 'utf-8'));
            expect(finalOnDisk).toHaveLength(2);
        });

        it('should clean up .tmp file when write or rename fails', async () => {
            const renameSpy = jest.spyOn(fs, 'rename').mockImplementationOnce(async () => {
                throw new Error('EIO: i/o error during rename');
            });

            await expect(
                repo.create({ amount: 5000, currency: 'USD' })
            ).rejects.toThrow('EIO: i/o error during rename');

            renameSpy.mockRestore();

            // Verify no leftover .tmp files
            const dir = path.dirname(testFilePath);
            const files = await fs.readdir(dir);
            const baseName = path.basename(testFilePath);
            const tmpFiles = files.filter(f => f.startsWith(baseName) && f.endsWith('.tmp'));
            expect(tmpFiles).toHaveLength(0);
        });
    });
});
