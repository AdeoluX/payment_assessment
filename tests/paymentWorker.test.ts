import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonPaymentRepo } from '../src/repositories/jsonPaymentRepo';
import { PaymentWorker } from '../src/workers/paymentWorker';
import { BankGateway, MockBankGateway } from '../src/gateway/bankGateway';

/**
 * Predicate polling helper replacing arbitrary setTimeout sleeps.
 * Polls every intervalMs until condition returns true or timeoutMs is exceeded.
 */
async function waitFor(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs = 3000,
    intervalMs = 10
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            if (await predicate()) return;
        } catch {
            // Ignore transient I/O or lock read errors during polling
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('PaymentWorker', () => {
    let testFilePath: string;
    let repo: JsonPaymentRepo;

    beforeEach(async () => {
        const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        testFilePath = path.join(os.tmpdir(), `worker-test-${uniqueId}.json`);
        repo = new JsonPaymentRepo(testFilePath);
        await repo.init();
    });

    afterEach(async () => {
        await fs.rm(testFilePath, { force: true }).catch(() => {});
    });

    it('should poll for PENDING payment, mark it PROCESSING, and finish as SUCCESS', async () => {
        const { payment } = await repo.create({ amount: 2500, currency: 'USD' });
        expect(payment.status).toBe('PENDING');

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 20,
            bankGateway: new MockBankGateway({ latencyMs: 5, forcedResult: 'SUCCESS' }),
        });

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'SUCCESS';
        });
        await worker.stop();

        const updated = await repo.findById(payment.id);
        expect(updated).not.toBeNull();
        expect(updated?.status).toBe('SUCCESS');
        expect(updated?.history).toHaveLength(3);
        expect(updated?.history[0].status).toBe('PENDING');
        expect(updated?.history[1].status).toBe('PROCESSING');
        expect(updated?.history[2].status).toBe('SUCCESS');
    });

    it('should retry on failure with backoff and succeed if retry passes', async () => {
        const { payment } = await repo.create({ amount: 1500, currency: 'EUR' });

        let attemptsMade = 0;
        const gateway = new MockBankGateway({
            latencyMs: 5,
            rule: (_p, attempt) => {
                attemptsMade = attempt;
                if (attempt < 2) {
                    return 'TRANSIENT_FAILURE';
                }
                return 'SUCCESS';
            },
        });

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 20,
            maxRetries: 3,
            initialRetryDelayMs: 15,
            retryBackoffFactor: 2,
            bankGateway: gateway,
        });

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'SUCCESS' && attemptsMade === 2;
        });
        await worker.stop();

        expect(attemptsMade).toBe(2);
        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('SUCCESS');
    });

    it('should retry when gateway fails transiently on attempts 1 and 2 and succeeds on attempt 3, asserting sleep is called twice and charge three times', async () => {
        const { payment } = await repo.create({ amount: 2500, currency: 'USD' });

        const gateway = new MockBankGateway({
            latencyMs: 5,
            rule: (_p, attempt) => {
                if (attempt === 1 || attempt === 2) {
                    return 'TRANSIENT_FAILURE';
                }
                return 'SUCCESS';
            },
        });

        const chargeSpy = jest.spyOn(gateway, 'charge');

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            maxRetries: 3,
            initialRetryDelayMs: 20,
            retryBackoffFactor: 2,
            enableJitter: false,
            bankGateway: gateway,
        });

        const sleepSpy = jest.spyOn(worker as any, 'sleep');

        await worker.start();

        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'SUCCESS' && chargeSpy.mock.calls.length === 3;
        });

        await worker.stop();

        // 1. Gateway charge was called exactly 3 times
        expect(chargeSpy).toHaveBeenCalledTimes(3);

        // 2. Sleep was called exactly 2 times (after attempt 1 and after attempt 2, not after attempt 3)
        expect(sleepSpy).toHaveBeenCalledTimes(2);
        expect(sleepSpy).toHaveBeenNthCalledWith(1, 20); // 20 * 2^0
        expect(sleepSpy).toHaveBeenNthCalledWith(2, 40); // 20 * 2^1

        // 3. Payment successfully updated to terminal SUCCESS
        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('SUCCESS');
    });

    it('should mark payment FAILED after exactly 3 charges and 2 sleeps when all retries are exhausted on transient failures', async () => {
        const { payment } = await repo.create({ amount: 3000, currency: 'NGN' });

        const gateway = new MockBankGateway({
            latencyMs: 5,
            forcedResult: 'TRANSIENT_FAILURE',
        });

        const chargeSpy = jest.spyOn(gateway, 'charge');

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            maxRetries: 3,
            initialRetryDelayMs: 20,
            retryBackoffFactor: 2,
            enableJitter: false,
            bankGateway: gateway,
        });

        const sleepSpy = jest.spyOn(worker as any, 'sleep');

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'FAILED';
        });
        await worker.stop();

        // 1. Gateway charge was attempted exactly 3 times
        expect(chargeSpy).toHaveBeenCalledTimes(3);

        // 2. Sleep was called exactly 2 times (between attempts 1->2 and 2->3, never after final failed attempt 3)
        expect(sleepSpy).toHaveBeenCalledTimes(2);
        expect(sleepSpy).toHaveBeenNthCalledWith(1, 20); // 20 * 2^0
        expect(sleepSpy).toHaveBeenNthCalledWith(2, 40); // 20 * 2^1

        // 3. Payment ends in terminal FAILED status
        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('FAILED');
        expect(updated?.failureReason).toContain('Bank gateway connection reset');
        expect(updated?.failureReason).toContain('after 3 attempt(s)');
    });

    it('should end in FAILED status after exactly 3 charges and 2 sleeps when gateway throws transient network exceptions', async () => {
        const { payment } = await repo.create({ amount: 4500, currency: 'USD' });

        const throwingGateway: BankGateway = {
            charge: jest.fn().mockRejectedValue(new Error('Transient connection reset')),
            inquire: jest.fn().mockResolvedValue(null),
        };

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            maxRetries: 3,
            initialRetryDelayMs: 20,
            retryBackoffFactor: 2,
            enableJitter: false,
            bankGateway: throwingGateway,
        });

        const sleepSpy = jest.spyOn(worker as any, 'sleep');

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'FAILED';
        });
        await worker.stop();

        // 1. Charge was attempted exactly 3 times
        expect(throwingGateway.charge).toHaveBeenCalledTimes(3);

        // 2. Sleep was called exactly 2 times (between attempts 1->2 and 2->3, never after final attempt 3)
        expect(sleepSpy).toHaveBeenCalledTimes(2);
        expect(sleepSpy).toHaveBeenNthCalledWith(1, 20);
        expect(sleepSpy).toHaveBeenNthCalledWith(2, 40);

        // 3. Payment ends in terminal FAILED status with exception message
        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('FAILED');
        expect(updated?.failureReason).toContain('Transient connection reset');
        expect(updated?.failureReason).toContain('after 3 attempt(s)');
    });

    it('should skip payment cleanly if another worker or process already grabbed it', async () => {
        const { payment } = await repo.create({ amount: 1000, currency: 'USD' });

        // Simulate another process grabbing it first
        await repo.update(payment.id, 'PENDING', { status: 'PROCESSING' });

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 50,
            bankGateway: new MockBankGateway({ latencyMs: 5 }),
        });

        // Worker should not throw and safely skip
        await expect(worker['processPayment'](payment)).resolves.not.toThrow();
    });

    it('should respect concurrency limits and not process more than the configured max at once', async () => {
        const payments = await Promise.all([
            repo.create({ amount: 100, currency: 'USD' }),
            repo.create({ amount: 200, currency: 'USD' }),
            repo.create({ amount: 300, currency: 'USD' }),
            repo.create({ amount: 400, currency: 'USD' }),
        ]);

        let maxConcurrentObserved = 0;
        let currentlyProcessing = 0;

        const customGateway: BankGateway = {
            charge: async () => {
                currentlyProcessing++;
                maxConcurrentObserved = Math.max(maxConcurrentObserved, currentlyProcessing);
                await new Promise(r => setTimeout(r, 40));
                currentlyProcessing--;
                return {
                    status: 'SUCCESS',
                    isRetryable: false,
                    timestamp: new Date().toISOString(),
                };
            },
            inquire: async () => null,
        };

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 10,
            concurrency: 2,
            bankGateway: customGateway,
        });

        await worker.start();
        await waitFor(async () => {
            const found = await Promise.all(payments.map(p => repo.findById(p.payment.id)));
            return found.every(p => p?.status === 'SUCCESS');
        });
        await worker.stop();

        expect(maxConcurrentObserved).toBeLessThanOrEqual(2);
        for (const p of payments) {
            const updated = await repo.findById(p.payment.id);
            expect(updated?.status).toBe('SUCCESS');
        }
    });

    it('should recover stuck PROCESSING payments on startup and complete them', async () => {
        const { payment } = await repo.create({ amount: 5000, currency: 'GBP' });
        await repo.update(payment.id, 'PENDING', { status: 'PROCESSING' });

        const stuckBefore = await repo.findByStatus('PROCESSING');
        expect(stuckBefore).toHaveLength(1);

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 1000,
            bankGateway: new MockBankGateway({ latencyMs: 10, forcedResult: 'SUCCESS' }),
        });

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'SUCCESS';
        });
        await worker.stop();

        const recovered = await repo.findById(payment.id);
        expect(recovered?.status).toBe('SUCCESS');
        expect(recovered?.history[recovered.history.length - 1].status).toBe('SUCCESS');
    });

    it('should catch errors and never let the application crash', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const explodingGateway: BankGateway = {
            charge: async () => {
                throw new Error('Explosive bank network crash');
            },
            inquire: async () => null,
        };

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            maxRetries: 1,
            bankGateway: explodingGateway,
        });

        const { payment } = await repo.create({ amount: 1000, currency: 'USD' });

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'FAILED';
        });
        await worker.stop();

        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('FAILED');
        expect(updated?.failureReason).toContain('Explosive bank network crash');

        errorSpy.mockRestore();
    });

    it('should wait for in-flight payments to finish before stop() resolves', async () => {
        const { payment } = await repo.create({ amount: 9999, currency: 'USD' });

        let jobStarted = false;
        let jobCompleted = false;

        const customGateway: BankGateway = {
            charge: async () => {
                jobStarted = true;
                await new Promise(r => setTimeout(r, 60));
                jobCompleted = true;
                return {
                    status: 'SUCCESS',
                    isRetryable: false,
                    timestamp: new Date().toISOString(),
                };
            },
            inquire: async () => null,
        };

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            bankGateway: customGateway,
        });

        await worker.start();
        // Wait until the payment is picked up and in-flight in customGateway
        await waitFor(() => jobStarted);

        // Now initiate stop while job is still running in customGateway
        await worker.stop();

        // When stop() resolves, the in-flight job must have fully finished
        expect(jobCompleted).toBe(true);

        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('SUCCESS');
    });

    it('should reconcile stuck PROCESSING payments by inquiring bank first without double-charging', async () => {
        const { payment } = await repo.create({
            amount: 7000,
            currency: 'USD',
            idempotencyKey: 'idem-stuck-123',
        });
        await repo.update(payment.id, 'PENDING', { status: 'PROCESSING' });

        const gateway = new MockBankGateway({ latencyMs: 5, forcedResult: 'SUCCESS' });
        const chargeSpy = jest.spyOn(gateway, 'charge');
        const inquireSpy = jest.spyOn(gateway, 'inquire');

        // Preload bank ledger as if charge succeeded right before crash
        await gateway.charge(payment, payment.id);
        chargeSpy.mockClear();

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 1000,
            bankGateway: gateway,
        });

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'SUCCESS';
        });
        await worker.stop();

        // Must have checked status via inquire with payment.id
        expect(inquireSpy).toHaveBeenCalledWith(payment.id, payment.id);
        // Must NOT have called charge again (no double-charge!)
        expect(chargeSpy).not.toHaveBeenCalled();

        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('SUCCESS');
    });

    it('should short-circuit and terminate immediately on non-retryable terminal errors without burning retries', async () => {
        const { payment } = await repo.create({ amount: 500, currency: 'USD' });

        const gateway = new MockBankGateway({
            latencyMs: 5,
            forcedResult: 'TERMINAL_FAILURE', // Insufficient funds (isRetryable: false)
        });

        const chargeSpy = jest.spyOn(gateway, 'charge');

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            maxRetries: 5,
            bankGateway: gateway,
        });

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'FAILED';
        });
        await worker.stop();

        // Terminal error should only attempt once
        expect(chargeSpy).toHaveBeenCalledTimes(1);

        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('FAILED');
        expect(updated?.failureReason).toContain('Insufficient funds');
    });

    it('should never sleep when encountering a terminal failure', async () => {
        const { payment } = await repo.create({ amount: 1500, currency: 'USD' });

        const gateway = new MockBankGateway({
            latencyMs: 5,
            forcedResult: 'TERMINAL_FAILURE', // isRetryable: false (e.g. Insufficient funds)
        });

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            maxRetries: 5,
            // Configure an enormous backoff delay (10 seconds) - if it sleeps, it will hang/timeout
            initialRetryDelayMs: 10000,
            bankGateway: gateway,
        });

        const sleepSpy = jest.spyOn(worker as any, 'sleep');

        const startTime = Date.now();
        await worker.start();

        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'FAILED';
        });

        await worker.stop();
        const durationMs = Date.now() - startTime;

        // 1. sleep() must NEVER have been called on a terminal failure
        expect(sleepSpy).not.toHaveBeenCalled();

        // 2. Execution must complete immediately (well under the 10-second backoff delay)
        expect(durationMs).toBeLessThan(1000);

        // 3. Payment is in terminal FAILED status with failure reason
        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('FAILED');
        expect(updated?.failureReason).toContain('Insufficient funds');
    });

    it('should not block start() during startup recovery and track recovery in activeJobs', async () => {
        const { payment } = await repo.create({ amount: 8000, currency: 'USD' });
        await repo.update(payment.id, 'PENDING', { status: 'PROCESSING' });

        const gateway = new MockBankGateway({ latencyMs: 100, forcedResult: 'SUCCESS' });
        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 1000,
            bankGateway: gateway,
        });

        const startTime = Date.now();
        await worker.start();
        const startDurationMs = Date.now() - startTime;

        // start() must have returned immediately without awaiting the 100ms bank call
        expect(startDurationMs).toBeLessThan(60);

        // Recovery job must be actively tracked in activeJobs
        expect(worker.getActiveJobsCount()).toBeGreaterThan(0);

        // stop() must wait for the tracked recovery job to finish
        await worker.stop();
        expect(worker.getActiveJobsCount()).toBe(0);

        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('SUCCESS');
    });

    it('should safely handle jobPromise rejections in poll() without emitting unhandled rejections', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const unhandledSpy = jest.fn();
        process.on('unhandledRejection', unhandledSpy);

        const { payment } = await repo.create({ amount: 1000, currency: 'USD' });

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            bankGateway: new MockBankGateway({ latencyMs: 5 }),
        });

        // Force processPayment to reject unexpectedly
        jest.spyOn(worker as any, 'processPayment').mockRejectedValue(new Error('Fatal pipeline reject'));

        await worker.start();
        await waitFor(() => errorSpy.mock.calls.length > 0);
        await worker.stop();

        expect(unhandledSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining(`Unhandled error processing payment ${payment.id}:`),
            expect.any(Error)
        );
        expect(worker.getActiveJobsCount()).toBe(0);

        process.off('unhandledRejection', unhandledSpy);
        errorSpy.mockRestore();
    });

    it('should pass attempt number to gateway.charge and use payment.id as idempotency key', async () => {
        const { payment } = await repo.create({ amount: 1200, currency: 'USD', idempotencyKey: 'user-idem-key' });

        const gateway = new MockBankGateway({ latencyMs: 5 });
        const chargeSpy = jest.spyOn(gateway, 'charge');

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            bankGateway: gateway,
        });

        await worker.start();
        await waitFor(() => chargeSpy.mock.calls.length > 0);
        await worker.stop();

        expect(chargeSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: payment.id }),
            payment.id,
            1
        );
    });

    it('should leave payment in PROCESSING instead of marking FAILED if shutdown aborts backoff sleep', async () => {
        const { payment } = await repo.create({ amount: 4500, currency: 'USD' });

        let attempt1Started = false;
        const gateway = new MockBankGateway({
            latencyMs: 5,
        });
        jest.spyOn(gateway, 'charge').mockImplementation(async () => {
            attempt1Started = true;
            return {
                status: 'FAILED',
                errorCode: 'NETWORK_TIMEOUT',
                failureReason: 'Transient timeout',
                isRetryable: true,
                timestamp: new Date().toISOString(),
            };
        });

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            bankGateway: gateway,
            maxRetries: 3,
            initialRetryDelayMs: 2000, // 2-second sleep so shutdown aborts it while sleeping
            enableJitter: false,
        });

        await worker.start();
        await waitFor(() => attempt1Started);

        // Abort worker while it is sleeping in backoff
        await worker.stop();

        // Payment must be left in PROCESSING, NOT FAILED!
        const current = await repo.findById(payment.id);
        expect(current?.status).toBe('PROCESSING');
    });

    it('should retry terminal state update in repository if transient error occurs', async () => {
        const { payment } = await repo.create({ amount: 5000, currency: 'USD' });

        let updateAttempts = 0;
        const originalUpdate = repo.update.bind(repo);
        jest.spyOn(repo, 'update').mockImplementation(async (id, expectedStatus, changes) => {
            if (changes.status === 'SUCCESS' || changes.status === 'FAILED') {
                updateAttempts++;
                if (updateAttempts === 1) {
                    throw new Error('Transient file lock / disk blip');
                }
            }
            return originalUpdate(id, expectedStatus, changes);
        });

        const worker = new PaymentWorker(repo, {
            pollIntervalMs: 15,
            bankGateway: new MockBankGateway({ latencyMs: 5, forcedResult: 'SUCCESS' }),
        });

        await worker.start();
        await waitFor(async () => {
            const p = await repo.findById(payment.id);
            return p?.status === 'SUCCESS' && updateAttempts >= 2;
        });
        await worker.stop();

        expect(updateAttempts).toBeGreaterThanOrEqual(2);
        const updated = await repo.findById(payment.id);
        expect(updated?.status).toBe('SUCCESS');
    });

    it('should coordinate between two workers sharing the same repo without double-charging or race conditions', async () => {
        // Create a batch of payments to be processed concurrently
        const paymentBatch = await Promise.all([
            repo.create({ amount: 1000, currency: 'USD' }),
            repo.create({ amount: 2000, currency: 'USD' }),
            repo.create({ amount: 3000, currency: 'USD' }),
            repo.create({ amount: 4000, currency: 'USD' }),
            repo.create({ amount: 5000, currency: 'USD' }),
            repo.create({ amount: 6000, currency: 'USD' }),
        ]);

        const sharedGateway = new MockBankGateway({
            latencyMs: 15,
            forcedResult: 'SUCCESS',
        });
        const chargeSpy = jest.spyOn(sharedGateway, 'charge');

        // Two independent workers sharing the exact same repository
        const worker1 = new PaymentWorker(repo, {
            pollIntervalMs: 10,
            concurrency: 2,
            bankGateway: sharedGateway,
        });

        const worker2 = new PaymentWorker(repo, {
            pollIntervalMs: 10,
            concurrency: 2,
            bankGateway: sharedGateway,
        });

        expect(worker1.workerId).not.toEqual(worker2.workerId);

        // Start both workers simultaneously
        await Promise.all([worker1.start(), worker2.start()]);

        // Await all payments to reach terminal SUCCESS status
        await waitFor(async () => {
            const found = await Promise.all(paymentBatch.map(p => repo.findById(p.payment.id)));
            return found.every(p => p?.status === 'SUCCESS');
        });

        // Gracefully stop both workers
        await Promise.all([worker1.stop(), worker2.stop()]);

        // Verification 1: Every payment reached terminal SUCCESS with proper audit history
        for (const { payment } of paymentBatch) {
            const updated = await repo.findById(payment.id);
            expect(updated?.status).toBe('SUCCESS');
            expect(updated?.history[updated.history.length - 1].status).toBe('SUCCESS');
        }

        // Verification 2: Strict idempotency - each payment was charged exactly once (no double-charges)
        expect(chargeSpy).toHaveBeenCalledTimes(paymentBatch.length);

        const chargedIds = chargeSpy.mock.calls.map(call => call[0].id);
        const uniqueChargedIds = new Set(chargedIds);
        expect(uniqueChargedIds.size).toBe(paymentBatch.length);
    });

    describe('MockBankGateway Random Distribution & Seed', () => {
        it('should yield ~80% success, ~10% transient, ~10% terminal across random samples', async () => {
            const gateway = new MockBankGateway({ latencyMs: 0, seed: 9999 });

            let successes = 0;
            let transientFailures = 0;
            let terminalFailures = 0;

            const sampleSize = 200;
            for (let i = 0; i < sampleSize; i++) {
                const dummyPayment = { id: `sample-${i}`, amount: 100, currency: 'USD' } as any;
                const result = await gateway.charge(dummyPayment, `idem-${i}`);
                if (result.status === 'SUCCESS') {
                    successes++;
                } else if (result.isRetryable) {
                    transientFailures++;
                } else {
                    terminalFailures++;
                }
            }

            const successRatio = successes / sampleSize;
            const transientRatio = transientFailures / sampleSize;
            const terminalRatio = terminalFailures / sampleSize;

            // Success around ~80% (between 70% and 90%)
            expect(successRatio).toBeGreaterThan(0.70);
            expect(successRatio).toBeLessThan(0.90);

            // Both types of failures observed
            expect(transientRatio).toBeGreaterThan(0.04);
            expect(terminalRatio).toBeGreaterThan(0.04);
            expect(successes + transientFailures + terminalFailures).toBe(sampleSize);
        });

        it('should produce identical outcomes with the same seed for test determinism', async () => {
            const gatewayA = new MockBankGateway({ latencyMs: 0, seed: 12345 });
            const gatewayB = new MockBankGateway({ latencyMs: 0, seed: 12345 });

            const resultsA: string[] = [];
            const resultsB: string[] = [];

            for (let i = 0; i < 20; i++) {
                const payment = { id: `det-${i}`, amount: 1000, currency: 'USD' } as any;
                const resA = await gatewayA.charge(payment, `det-${i}`);
                const resB = await gatewayB.charge(payment, `det-${i}`);
                resultsA.push(`${resA.status}:${resA.isRetryable}`);
                resultsB.push(`${resB.status}:${resB.isRetryable}`);
            }

            expect(resultsA).toEqual(resultsB);
        });
    });
});
