import { createApp } from './app';
import { JsonPaymentRepo } from './repositories/jsonPaymentRepo';
import { loadConfig } from './config';
import { PaymentWorker } from './workers/paymentWorker';

async function bootstrap() {
    const config = loadConfig();
    const repo = new JsonPaymentRepo(config.fileStorage);

    // Fail-fast: Validate storage integrity before opening server port
    await repo.init();

    // Start background payment worker with options from config
    const worker = new PaymentWorker(repo, config.worker);
    await worker.start();

    const app = createApp(repo, config.adminApiKey);

    const server = app.listen(config.port, () => {
        console.log(`Payment service listening on port ${config.port}`);
    });

    let isShuttingDown = false;

    const handleShutdown = (signal: string) => async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        console.log(`${signal} received, shutting down gracefully`);

        // 10s force-exit timeout to prevent hanging indefinitely
        const forceExitTimer = setTimeout(() => {
            console.error('Shutdown timed out after 10s, forcing exit');
            process.exit(1);
        }, 10000);
        forceExitTimer.unref();

        try {
            // 1. server.close first (stops accepting new HTTP requests)
            await new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });

            // 2. worker.stop() second (drain in-flight payment processing jobs)
            await worker.stop();

            clearTimeout(forceExitTimer);
            console.log('Payment service down');
            process.exit(0);
        } catch (err) {
            clearTimeout(forceExitTimer);
            console.error('Error during shutdown:', err);
            process.exit(1);
        }
    };

    process.on('SIGTERM', handleShutdown('SIGTERM'));
    process.on('SIGINT', handleShutdown('SIGINT'));
}

bootstrap().catch((err) => {
    console.error('Fatal: Failed to start service:', err.message);
    process.exit(1);
});