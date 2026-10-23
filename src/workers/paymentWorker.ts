import { Payment } from '../domain/payment';
import { PaymentRepository } from '../domain/paymentRepository';
import { ConflictError } from '../error';
import { BankGateway, BankTransactionResult, MockBankGateway } from '../gateway/bankGateway';

export type WorkerState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'DRAINING';

export interface PaymentWorkerOptions {
    /** Polling interval in milliseconds. Default: 1000 */
    pollIntervalMs?: number;
    /** Maximum number of concurrent payments being processed. Default: 3 */
    concurrency?: number;
    /** Maximum attempts before declaring terminal failure. Default: 3 */
    maxRetries?: number;
    /** Initial base delay for exponential backoff in ms. Default: 100 */
    initialRetryDelayMs?: number;
    /** Multiplier factor for backoff. Default: 2 */
    retryBackoffFactor?: number;
    /** Maximum cap for retry delay in ms. Default: 5000 */
    maxRetryDelayMs?: number;
    /** Whether to add jitter to backoff delay to prevent thundering herd. Default: true */
    enableJitter?: boolean;
    /** Age in ms after which a PROCESSING payment is considered orphaned/stuck. Default: 0 (recover all on start) */
    staleProcessingTimeoutMs?: number;
    /** Simulated latency in ms for default mock bank. Default: 50 */
    bankLatencyMs?: number;
    /** Pluggable bank gateway client implementing BankGateway */
    bankGateway?: BankGateway;
}

export interface WorkerTelemetryEvent {
    timestamp: string;
    workerId: string;
    type: 'CLAIM' | 'BANK_ATTEMPT' | 'RETRY' | 'SUCCESS' | 'FAILED' | 'RECONCILED' | 'SKIPPED' | 'ERROR';
    paymentId: string;
    attempt?: number;
    details?: Record<string, unknown>;
}

export class PaymentWorker {
    public readonly workerId: string;
    private state: WorkerState = 'STOPPED';
    private pollTimer: NodeJS.Timeout | null = null;
    private readonly activeJobs = new Set<Promise<void>>();
    private abortController = new AbortController();

    private readonly pollIntervalMs: number;
    private readonly concurrency: number;
    private readonly maxRetries: number;
    private readonly initialRetryDelayMs: number;
    private readonly retryBackoffFactor: number;
    private readonly maxRetryDelayMs: number;
    private readonly enableJitter: boolean;
    private readonly staleProcessingTimeoutMs: number;

    private readonly bankGateway: BankGateway;

    constructor(
        private readonly repo: PaymentRepository,
        options: PaymentWorkerOptions = {}
    ) {
        this.workerId = `worker_${Math.random().toString(36).slice(2, 8)}`;
        this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 1000);
        this.concurrency = Math.max(1, options.concurrency ?? 3);
        this.maxRetries = Math.max(1, options.maxRetries ?? 3);
        this.initialRetryDelayMs = Math.max(1, options.initialRetryDelayMs ?? 100);
        this.retryBackoffFactor = Math.max(1, options.retryBackoffFactor ?? 2);
        this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5000;
        this.enableJitter = options.enableJitter ?? true;
        this.staleProcessingTimeoutMs = options.staleProcessingTimeoutMs ?? 0;

        if (options.bankGateway) {
            this.bankGateway = options.bankGateway;
        } else {
            this.bankGateway = new MockBankGateway({
                latencyMs: options.bankLatencyMs ?? 50,
            });
        }
    }

    getState(): WorkerState {
        return this.state;
    }

    getIsRunning(): boolean {
        return this.state === 'RUNNING';
    }

    getActiveJobsCount(): number {
        return this.activeJobs.size;
    }

    /**
     * Start the worker.
     * 1. Reconciles any orphaned payments left in PROCESSING from an earlier crash.
     * 2. Starts periodic polling loop for new PENDING transactions.
     */
    async start(): Promise<void> {
        if (this.state === 'RUNNING' || this.state === 'STARTING') return;

        this.state = 'RUNNING';
        this.abortController = new AbortController();

        // Run startup recovery as background tracked jobs in activeJobs that don't block start()
        this.triggerStartupRecovery();

        // Start periodic polling immediately
        this.scheduleNextPoll(0);
    }

    private triggerStartupRecovery(): void {
        let recoveryDispatch: Promise<void>;
        recoveryDispatch = this.recoverStuckPayments()
            .catch((err) => {
                console.error('[PaymentWorker] Failed during startup stuck payments recovery dispatch:', err);
            })
            .finally(() => {
                this.activeJobs.delete(recoveryDispatch);
            });
        this.activeJobs.add(recoveryDispatch);
    }

    /**
     * Gracefully stops the worker:
     * 1. Stops polling.
     * 2. Signals abort for any active sleep timers.
     * 3. Awaits all currently executing payment processing jobs to complete.
     */
    async stop(): Promise<void> {
        if (this.state === 'STOPPED') return;

        this.state = 'DRAINING';

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        // Abort pending backoff sleep timers
        this.abortController.abort();

        // Await all in-flight jobs to finish cleanly
        while (this.activeJobs.size > 0) {
            await Promise.all(Array.from(this.activeJobs));
        }

        this.state = 'STOPPED';
    }

    /**
     * Startup reconciliation:
     * Discovers payments stranded in PROCESSING from a sudden crash/restart.
     * Uses Two-Phase Recovery:
     *   1. Queries the bank first using the payment's idempotency key.
     *   2. If the bank already captured it, updates locally to SUCCESS (prevents duplicate charges).
     *   3. If not yet captured, resumes normal processing.
     */
    async recoverStuckPayments(): Promise<void> {
        try {
            const stuckPayments = await this.repo.findByStatus('PROCESSING');
            const now = Date.now();

            const eligiblePayments = stuckPayments.filter(p => {
                if (this.staleProcessingTimeoutMs <= 0) return true;
                const updatedTime = new Date(p.updatedAt).getTime();
                return now - updatedTime >= this.staleProcessingTimeoutMs;
            });

            if (eligiblePayments.length > 0) {
                this.log({
                    type: 'RECONCILED',
                    paymentId: 'BATCH',
                    details: { count: eligiblePayments.length },
                });
            }

            for (const payment of eligiblePayments) {
                if (this.state === 'STOPPED') break;

                let jobPromise: Promise<void>;
                jobPromise = this.reconcileStuckPayment(payment)
                    .catch((err) => {
                        console.error(`[PaymentWorker] Unhandled error reconciling stuck payment ${payment.id}:`, err);
                    })
                    .finally(() => {
                        this.activeJobs.delete(jobPromise);
                    });
                this.activeJobs.add(jobPromise);
            }
        } catch (err) {
            console.error('[PaymentWorker] Failed during stuck payments recovery:', err);
        }
    }

    private async reconcileStuckPayment(payment: Payment): Promise<void> {
        const idempotencyKey = payment.id;

        // Phase 1: Bank Inquiry (Did the bank process this before the crash?)
        let priorResult: BankTransactionResult | null = null;
        try {
            priorResult = await this.bankGateway.inquire(payment.id, idempotencyKey);
        } catch (inquireErr) {
            console.warn(`[PaymentWorker] Status inquiry failed for stuck payment ${payment.id}:`, inquireErr);
        }

        if (priorResult && priorResult.status === 'SUCCESS') {
            // Bank already processed it: finalize locally without double-charging
            await this.updateTerminalState(payment.id, 'SUCCESS');
            return;
        }

        if (priorResult && priorResult.status === 'FAILED' && !priorResult.isRetryable) {
            // Bank already rejected it: finalize locally
            await this.updateTerminalState(
                payment.id,
                'FAILED',
                priorResult.failureReason || 'Declined prior to crash'
            );
            return;
        }

        // Phase 2: Not yet captured or transient — finish processing through bank
        await this.executeBankFlow(payment);
    }

    private scheduleNextPoll(delayMs = this.pollIntervalMs): void {
        if (this.state !== 'RUNNING') return;

        this.pollTimer = setTimeout(async () => {
            await this.poll();
        }, delayMs);
    }

    private async poll(): Promise<void> {
        if (this.state !== 'RUNNING') return;

        try {
            // Check concurrency slots before hitting database
            const availableSlots = this.concurrency - this.activeJobs.size;
            if (availableSlots > 0) {
                const pending = await this.repo.findByStatus('PENDING');
                const batch = pending.slice(0, availableSlots);

                for (const payment of batch) {
                    if (this.activeJobs.size >= this.concurrency || this.state !== 'RUNNING') {
                        break;
                    }

                    let jobPromise: Promise<void>;
                    jobPromise = this.processPayment(payment)
                        .catch((err) => {
                            console.error(`[PaymentWorker] Unhandled error processing payment ${payment.id}:`, err);
                        })
                        .finally(() => {
                            this.activeJobs.delete(jobPromise);
                        });
                    this.activeJobs.add(jobPromise);
                }
            }
        } catch (err) {
            console.error('[PaymentWorker] Error in polling loop:', err);
        } finally {
            if (this.state === 'RUNNING') {
                this.scheduleNextPoll();
            }
        }
    }

    private async processPayment(payment: Payment): Promise<void> {
        try {
            // Step 1: Claim payment atomically (PENDING -> PROCESSING)
            let claimedPayment: Payment;
            try {
                claimedPayment = await this.repo.update(payment.id, 'PENDING', {
                    status: 'PROCESSING',
                });
                this.log({ type: 'CLAIM', paymentId: payment.id });
            } catch (err) {
                if (err instanceof ConflictError) {
                    // Contention: another worker or admin already modified this payment
                    this.log({
                        type: 'SKIPPED',
                        paymentId: payment.id,
                        details: { reason: 'Optimistic lock contention' },
                    });
                    return;
                }
                throw err;
            }

            // Step 2: Execute bank interaction with retry policy
            await this.executeBankFlow(claimedPayment);
        } catch (err) {
            console.error(`[PaymentWorker] Uncaught exception processing payment ${payment.id}:`, err);
        }
    }

    private async executeBankFlow(payment: Payment): Promise<void> {
        const idempotencyKey = payment.id;
        let attempt = 0;
        let lastError = 'Bank transaction failed';
        let isSuccess = false;

        while (attempt < this.maxRetries) {
            attempt++;
            this.log({ type: 'BANK_ATTEMPT', paymentId: payment.id, attempt });

            try {
                const result = await this.bankGateway.charge(payment, idempotencyKey, attempt);
                const attemptResult = {
                    success: result.status === 'SUCCESS',
                    error: result.failureReason || result.errorCode,
                    isRetryable: result.isRetryable,
                };

                if (attemptResult.success) {
                    isSuccess = true;
                    break;
                }

                lastError = attemptResult.error || `Bank declined on attempt ${attempt}`;

                // Non-retryable / terminal error: do not waste retries (e.g. Insufficient funds, invalid card)
                if (attemptResult.isRetryable === false) {
                    this.log({
                        type: 'FAILED',
                        paymentId: payment.id,
                        attempt,
                        details: { reason: lastError, isTerminal: true },
                    });
                    break;
                }
            } catch (err: any) {
                lastError = err?.message || `Bank communication threw exception on attempt ${attempt}`;
            }

            if (attempt < this.maxRetries) {
                const backoffDelay = this.calculateBackoff(attempt);
                this.log({
                    type: 'RETRY',
                    paymentId: payment.id,
                    attempt,
                    details: { nextAttemptInMs: backoffDelay, error: lastError },
                });
                await this.sleep(backoffDelay);

                // If shutdown aborts a backoff, leave the payment in PROCESSING instead of marking it FAILED
                if (this.abortController.signal.aborted || this.state === 'DRAINING' || this.state === 'STOPPED') {
                    this.log({
                        type: 'SKIPPED',
                        paymentId: payment.id,
                        details: { reason: 'Shutdown aborted backoff: leaving payment in PROCESSING' },
                    });
                    return;
                }
            }
        }

        // Step 3: Transition to terminal state (SUCCESS or FAILED)
        if (isSuccess) {
            await this.updateTerminalState(payment.id, 'SUCCESS');
            this.log({ type: 'SUCCESS', paymentId: payment.id, attempt });
        } else {
            const reason = `Bank failed after ${attempt} attempt(s): ${lastError}`;
            await this.updateTerminalState(payment.id, 'FAILED', reason);
            this.log({ type: 'FAILED', paymentId: payment.id, attempt, details: { reason } });
        }
    }

    private async updateTerminalState(
        id: string,
        status: 'SUCCESS' | 'FAILED',
        failureReason?: string,
        maxRetries = 3
    ): Promise<void> {
        let attempt = 0;
        while (attempt < maxRetries) {
            attempt++;
            try {
                if (status === 'SUCCESS') {
                    await this.repo.update(id, 'PROCESSING', { status: 'SUCCESS' });
                } else {
                    await this.repo.update(id, 'PROCESSING', {
                        status: 'FAILED',
                        failureReason: failureReason || 'Payment failed',
                    });
                }
                return;
            } catch (err) {
                if (err instanceof ConflictError) {
                    console.warn(`[PaymentWorker] Terminal state conflict for ${id}: payment status already modified.`);
                    return;
                }
                if (attempt >= maxRetries) {
                    console.error(`[PaymentWorker] Failed to update terminal state for ${id} after ${attempt} attempts:`, err);
                    throw err;
                }
                await new Promise(resolve => setTimeout(resolve, 50 * attempt));
            }
        }
    }

    /**
     * Exponential Backoff with Full Jitter:
     * Full Jitter randomizes delay uniformly between 0 and min(maxDelay, baseDelay * 2^(attempt-1)).
     * Prevents thundering-herd effect when multiple retries coordinate on a recovered downstream service.
     */
    private calculateBackoff(attempt: number): number {
        const rawDelay = this.initialRetryDelayMs * Math.pow(this.retryBackoffFactor, attempt - 1);
        const cappedDelay = Math.min(this.maxRetryDelayMs, rawDelay);

        if (!this.enableJitter) {
            return Math.floor(cappedDelay);
        }

        return Math.floor(Math.random() * cappedDelay);
    }

    private sleep(ms: number): Promise<void> {
        if (ms <= 0) return Promise.resolve();

        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);

            // Cancel sleep immediately if worker is stopped/drained
            const onAbort = () => {
                clearTimeout(timer);
                resolve();
            };

            this.abortController.signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    private log(event: Omit<WorkerTelemetryEvent, 'timestamp' | 'workerId'>): void {
        const telemetry: WorkerTelemetryEvent = {
            timestamp: new Date().toISOString(),
            workerId: this.workerId,
            ...event,
        };
        // Can be routed to Datadog/CloudWatch/Winston; output clean structured logs
        if (process.env.DEBUG_WORKER) {
            console.log(`[PaymentWorker][${telemetry.type}] ${telemetry.paymentId}:`, telemetry);
        }
    }
}
