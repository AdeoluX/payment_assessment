import { PaymentWorkerOptions } from './workers/paymentWorker';

export interface AppConfig {
    port: number;
    fileStorage: string;
    adminApiKey: string;
    worker: PaymentWorkerOptions;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const adminApiKey = env.ADMIN_API_KEY;
    if (!adminApiKey || adminApiKey.trim() === '') {
        throw new Error("Fatal: Required environment variable 'ADMIN_API_KEY' is unset.");
    }

    const worker: PaymentWorkerOptions = {};
    if (env.WORKER_POLL_INTERVAL_MS !== undefined && !isNaN(Number(env.WORKER_POLL_INTERVAL_MS))) {
        worker.pollIntervalMs = Number(env.WORKER_POLL_INTERVAL_MS);
    }
    if (env.WORKER_CONCURRENCY !== undefined && !isNaN(Number(env.WORKER_CONCURRENCY))) {
        worker.concurrency = Number(env.WORKER_CONCURRENCY);
    }
    if (env.WORKER_MAX_RETRIES !== undefined && !isNaN(Number(env.WORKER_MAX_RETRIES))) {
        worker.maxRetries = Number(env.WORKER_MAX_RETRIES);
    }
    if (env.WORKER_INITIAL_RETRY_DELAY_MS !== undefined && !isNaN(Number(env.WORKER_INITIAL_RETRY_DELAY_MS))) {
        worker.initialRetryDelayMs = Number(env.WORKER_INITIAL_RETRY_DELAY_MS);
    }
    if (env.WORKER_RETRY_BACKOFF_FACTOR !== undefined && !isNaN(Number(env.WORKER_RETRY_BACKOFF_FACTOR))) {
        worker.retryBackoffFactor = Number(env.WORKER_RETRY_BACKOFF_FACTOR);
    }
    if (env.WORKER_MAX_RETRY_DELAY_MS !== undefined && !isNaN(Number(env.WORKER_MAX_RETRY_DELAY_MS))) {
        worker.maxRetryDelayMs = Number(env.WORKER_MAX_RETRY_DELAY_MS);
    }
    if (env.WORKER_ENABLE_JITTER !== undefined) {
        worker.enableJitter = env.WORKER_ENABLE_JITTER !== 'false';
    }
    if (env.WORKER_STALE_PROCESSING_TIMEOUT_MS !== undefined && !isNaN(Number(env.WORKER_STALE_PROCESSING_TIMEOUT_MS))) {
        worker.staleProcessingTimeoutMs = Number(env.WORKER_STALE_PROCESSING_TIMEOUT_MS);
    }
    if (env.WORKER_BANK_LATENCY_MS !== undefined && !isNaN(Number(env.WORKER_BANK_LATENCY_MS))) {
        worker.bankLatencyMs = Number(env.WORKER_BANK_LATENCY_MS);
    }

    return {
        port: Number(env.PORT) || 3000,
        fileStorage: env.FILE_STORAGE || './data/payments.json',
        adminApiKey: adminApiKey.trim(),
        worker,
    };
}
