import { Payment } from '../domain/payment';

export type BankErrorCode =
    | 'INSUFFICIENT_FUNDS'
    | 'CARD_EXPIRED'
    | 'CARD_BLOCKED'
    | 'FRAUD_REJECTED'
    | 'NETWORK_TIMEOUT'
    | 'GATEWAY_UNAVAILABLE'
    | 'RATE_LIMITED';

export interface BankTransactionResult {
    status: 'SUCCESS' | 'FAILED';
    transactionId?: string;
    errorCode?: BankErrorCode | string;
    failureReason?: string;
    isRetryable: boolean;
    timestamp: string;
}

export interface BankGateway {
    charge(payment: Payment, idempotencyKey: string, attempt?: number): Promise<BankTransactionResult>;
    inquire(paymentId: string, idempotencyKey: string): Promise<BankTransactionResult | null>;
}

export interface MockBankOptions {
    /** Simulated latency in milliseconds. Default: 50 */
    latencyMs?: number;
    /** Optional seed for deterministic random outcomes in tests */
    seed?: number;
    /** Success probability (0 to 1). Default: 0.80 (80% success) */
    successRate?: number;
    /** Transient failure probability (0 to 1). Default: 0.10 (10% transient) */
    transientFailureRate?: number;
    /** If set, forces all charge calls to this result */
    forcedResult?: 'SUCCESS' | 'TRANSIENT_FAILURE' | 'TERMINAL_FAILURE';
    /** Custom rule function based on attempt count or payment */
    rule?: (payment: Payment, attempt: number) => 'SUCCESS' | 'TRANSIENT_FAILURE' | 'TERMINAL_FAILURE';
}

function createPrng(seed?: number): () => number {
    if (seed === undefined) {
        return Math.random;
    }
    // Mulberry32 deterministic 32-bit PRNG
    let s = seed >>> 0;
    return () => {
        s |= 0;
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Stateful MockBankGateway simulating realistic payment processing:
 * 1. Simulates latency
 * 2. Probabilistic outcomes: ~80% success, ~10% transient failure, ~10% terminal failure
 * 3. Seedable PRNG for deterministic testing
 * 4. Idempotency ledger for status inquiry during crash reconciliation
 */
export class MockBankGateway implements BankGateway {
    private readonly ledger = new Map<string, BankTransactionResult>();
    private readonly rng: () => number;
    private readonly successRate: number;
    private readonly transientFailureRate: number;

    private latencyMs: number;
    private forcedResult?: 'SUCCESS' | 'TRANSIENT_FAILURE' | 'TERMINAL_FAILURE';
    private rule?: (payment: Payment, attempt: number) => 'SUCCESS' | 'TRANSIENT_FAILURE' | 'TERMINAL_FAILURE';

    constructor(options: MockBankOptions = {}) {
        this.latencyMs = options.latencyMs ?? 50;
        this.forcedResult = options.forcedResult;
        this.rule = options.rule;
        this.rng = createPrng(options.seed);
        this.successRate = options.successRate ?? 0.80;
        this.transientFailureRate = options.transientFailureRate ?? 0.10;
    }

    setLatency(ms: number): void {
        this.latencyMs = ms;
    }

    setForcedResult(result?: 'SUCCESS' | 'TRANSIENT_FAILURE' | 'TERMINAL_FAILURE'): void {
        this.forcedResult = result;
    }

    setRule(rule?: (payment: Payment, attempt: number) => 'SUCCESS' | 'TRANSIENT_FAILURE' | 'TERMINAL_FAILURE'): void {
        this.rule = rule;
    }

    async charge(payment: Payment, idempotencyKey: string, attempt = 1): Promise<BankTransactionResult> {
        if (this.latencyMs > 0) {
            await new Promise(r => setTimeout(r, this.latencyMs));
        }

        // Idempotency check: if bank already captured this transaction, return recorded result
        const existing = this.ledger.get(idempotencyKey);
        if (existing) {
            return existing;
        }

        const outcome = this.determineOutcome(payment, attempt);

        if (outcome === 'SUCCESS') {
            const result: BankTransactionResult = {
                status: 'SUCCESS',
                transactionId: `txn_${Math.random().toString(36).slice(2, 10)}`,
                isRetryable: false,
                timestamp: new Date().toISOString(),
            };
            this.ledger.set(idempotencyKey, result);
            return result;
        }

        if (outcome === 'TERMINAL_FAILURE') {
            const result: BankTransactionResult = {
                status: 'FAILED',
                errorCode: 'INSUFFICIENT_FUNDS',
                failureReason: 'Terminal failure: Insufficient funds in account',
                isRetryable: false,
                timestamp: new Date().toISOString(),
            };
            // Terminal failures are finalized at the bank
            this.ledger.set(idempotencyKey, result);
            return result;
        }

        // Transient failure (network/timeout) - NOT stored as final in bank ledger so it can be retried
        return {
            status: 'FAILED',
            errorCode: 'NETWORK_TIMEOUT',
            failureReason: 'Transient network failure: Bank gateway connection reset',
            isRetryable: true,
            timestamp: new Date().toISOString(),
        };
    }

    async inquire(paymentId: string, idempotencyKey: string): Promise<BankTransactionResult | null> {
        if (this.latencyMs > 0) {
            await new Promise(r => setTimeout(r, Math.floor(this.latencyMs / 2)));
        }
        return this.ledger.get(idempotencyKey) || null;
    }

    private determineOutcome(payment: Payment, attempt: number): 'SUCCESS' | 'TRANSIENT_FAILURE' | 'TERMINAL_FAILURE' {
        if (this.rule) {
            return this.rule(payment, attempt);
        }
        if (this.forcedResult) {
            return this.forcedResult;
        }

        const roll = this.rng();
        if (roll < this.successRate) {
            return 'SUCCESS';
        }
        if (roll < this.successRate + this.transientFailureRate) {
            return 'TRANSIENT_FAILURE';
        }
        return 'TERMINAL_FAILURE';
    }
}
