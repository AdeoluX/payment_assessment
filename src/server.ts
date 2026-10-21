import { createApp } from './app'
import { JsonPaymentRepo } from './repositories/jsonPaymentRepo'

const PORT = Number(process.env.PORT) || 3000;

const repo = new JsonPaymentRepo(process.env.FILE_STORAGE || './data/payments.json')

const app = createApp(repo);

const server = app.listen(PORT, () => {
    console.log(`Payment service listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Payment service down')
        process.exit(0)
    })
})