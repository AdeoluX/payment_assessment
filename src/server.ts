import { createApp } from './app';
import { JsonPaymentRepo } from './repositories/jsonPaymentRepo';
import { loadConfig } from './config';

async function bootstrap() {
    const config = loadConfig();
    const repo = new JsonPaymentRepo(config.fileStorage);

    // Fail-fast: Validate storage integrity before opening server port
    await repo.init();

    const app = createApp(repo, config.adminApiKey);

    const server = app.listen(config.port, () => {
        console.log(`Payment service listening on port ${config.port}`);
    });

    process.on('SIGTERM', () => {
        console.log('SIGTERM received, shutting down gracefully');
        server.close(() => {
            console.log('Payment service down');
            process.exit(0);
        });
    });
}

bootstrap().catch((err) => {
    console.error('Fatal: Failed to start service:', err.message);
    process.exit(1);
});