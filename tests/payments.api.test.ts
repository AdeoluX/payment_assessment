import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app';
import { JsonPaymentRepo } from '../src/repositories/jsonPaymentRepo';
import { loadConfig } from '../src/config';

describe('Payments API Endpoints', () => {
    let testFilePath: string;
    let repo: JsonPaymentRepo;
    let app: ReturnType<typeof createApp>;
    const ADMIN_KEY = 'test-operator-secret';
    const originalEnvKey = process.env.ADMIN_API_KEY;

    beforeAll(() => {
        process.env.ADMIN_API_KEY = ADMIN_KEY;
    });

    afterAll(() => {
        if (originalEnvKey !== undefined) {
            process.env.ADMIN_API_KEY = originalEnvKey;
        } else {
            delete process.env.ADMIN_API_KEY;
        }
    });

    beforeEach(async () => {
        const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        testFilePath = path.join(os.tmpdir(), `api-test-${uniqueId}.json`);
        repo = new JsonPaymentRepo(testFilePath);
        await repo.init();
        app = createApp(repo, ADMIN_KEY);
    });

    afterEach(async () => {
        await fs.rm(testFilePath, { force: true }).catch(() => {});
    });

    describe('GET /health (Store Readiness & Writability)', () => {
        it('should return 200 with store ready when repository is initialized and writable', async () => {
            const res = await request(app).get('/health');

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                success: true,
                data: { status: 'ok', store: 'ready' },
            });
            expect(res.headers['x-powered-by']).toBeUndefined();
        });

        it('should return 503 with store unready if repository has not been initialized', async () => {
            const uninitializedRepo = new JsonPaymentRepo(testFilePath);
            const unreadyApp = createApp(uninitializedRepo, ADMIN_KEY);

            const res = await request(unreadyApp).get('/health');

            expect(res.status).toBe(503);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
            expect(res.body.error.details).toEqual({
                status: 'error',
                store: 'unready',
            });
        });

        it('should return 503 with store unready if the storage directory is removed after init', async () => {
            const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'store-unready-'));
            const isolatedFile = path.join(isolatedDir, 'payments.json');

            const isolatedRepo = new JsonPaymentRepo(isolatedFile);
            await isolatedRepo.init();
            const isolatedApp = createApp(isolatedRepo, ADMIN_KEY);

            // Verify it was ready initially
            expect(await isolatedRepo.isReady()).toBe(true);

            // Delete storage directory (simulating unmounted volume / detached storage)
            await fs.rm(isolatedDir, { recursive: true, force: true });

            // Store is now unreachable and unwritable
            const res = await request(isolatedApp).get('/health');
            expect(res.status).toBe(503);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
            expect(res.body.error.details).toEqual({
                status: 'error',
                store: 'unready',
            });
        });

        it('should refuse to initialize and boot when the database file is corrupted', async () => {
            const corruptFilePath = path.join(os.tmpdir(), `corrupt-boot-${Date.now()}.json`);
            await fs.writeFile(corruptFilePath, '{ "broken": json', 'utf-8');

            const brokenRepo = new JsonPaymentRepo(corruptFilePath);
            await expect(brokenRepo.init()).rejects.toThrow(/invalid JSON syntax/i);

            await fs.rm(corruptFilePath, { force: true }).catch(() => {});
        });
    });

    describe('POST /payments', () => {
        it('should return 201 Created on new payment', async () => {
            const res = await request(app)
                .post('/payments')
                .set('Idempotency-Key', 'k1')
                .send({ amount: 5000, currency: 'ngn' });

            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.id).toBeDefined();
            expect(res.body.data.amount).toBe(5000);
            expect(res.body.data.currency).toBe('NGN');
            expect(res.body.data.status).toBe('PENDING');
            expect(res.body.data.idempotencyKey).toBe('k1');
            expect(res.headers['x-powered-by']).toBeUndefined();
        });

        it('should return 200 OK on idempotent retry with the exact same key', async () => {
            // First call
            const firstRes = await request(app)
                .post('/payments')
                .set('Idempotency-Key', 'k2')
                .send({ amount: 7500, currency: 'USD' });
            expect(firstRes.status).toBe(201);

            // Replay call
            const secondRes = await request(app)
                .post('/payments')
                .set('Idempotency-Key', 'k2')
                .send({ amount: 7500, currency: 'USD' });

            expect(secondRes.status).toBe(200);
            expect(secondRes.body.success).toBe(true);
            expect(secondRes.body.data.id).toBe(firstRes.body.data.id);
        });

        it('should handle 20 parallel HTTP requests with the same key (1 201 Created, 19 200 OK)', async () => {
            const parallelRequests = Array.from({ length: 20 }, () =>
                request(app)
                    .post('/payments')
                    .set('Idempotency-Key', 'http-parallel-key')
                    .send({ amount: 6000, currency: 'NGN' })
            );

            const responses = await Promise.all(parallelRequests);

            const created201 = responses.filter(r => r.status === 201);
            const ok200 = responses.filter(r => r.status === 200);

            expect(created201).toHaveLength(1);
            expect(ok200).toHaveLength(19);

            const targetId = created201[0].body.data.id;
            for (const res of responses) {
                expect(res.body.data.id).toBe(targetId);
            }
        });

        it('should return 409 Conflict if same idempotency key is reused with different parameters', async () => {
            await request(app)
                .post('/payments')
                .set('Idempotency-Key', 'k3')
                .send({ amount: 3000, currency: 'EUR' });

            const conflictRes = await request(app)
                .post('/payments')
                .set('Idempotency-Key', 'k3')
                .send({ amount: 9999, currency: 'EUR' });

            expect(conflictRes.status).toBe(409);
            expect(conflictRes.body.success).toBe(false);
            expect(conflictRes.body.error.code).toBe('CONFLICT');
        });

        it('should return 400 Bad Request on decimal amount', async () => {
            const res = await request(app)
                .post('/payments')
                .send({ amount: 50.75, currency: 'NGN' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('should return 400 Bad Request with clear message when integer exceeds safe range', async () => {
            const res = await request(app)
                .post('/payments')
                .send({ amount: 1e21, currency: 'USD' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
            const detailsStr = JSON.stringify(res.body.error.details);
            expect(detailsStr).toContain('Amount is too large to store exactly');
            expect(detailsStr).not.toContain('no decimals');
        });

        it('should return 400 Bad Request on negative amount', async () => {
            const res = await request(app)
                .post('/payments')
                .send({ amount: -100, currency: 'NGN' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('should return 400 Bad Request on invalid currency code length', async () => {
            const res = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'US' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('should return 400 Bad Request if currency does not consist of 3 alphabetical letters', async () => {
            const numRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: '123' });

            expect(numRes.status).toBe(400);
            expect(numRes.body.success).toBe(false);
            expect(numRes.body.error.code).toBe('VALIDATION_ERROR');

            const symRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: '$%^' });

            expect(symRes.status).toBe(400);
            expect(symRes.body.success).toBe(false);
            expect(symRes.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('should return 400 Bad Request if currency is 3 letters but not a recognized ISO 4217 currency code', async () => {
            const res = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'ZZZ' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
            expect(res.body.error.details).toBeDefined();
        });

        it('should return 400 Bad Request if Idempotency-Key header exceeds 255 characters (e.g. 5000 characters)', async () => {
            const excessivelyLongKey = 'k'.repeat(5000);
            const res = await request(app)
                .post('/payments')
                .set('Idempotency-Key', excessivelyLongKey)
                .send({ amount: 2000, currency: 'USD' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
            expect(res.body.error.message).toMatch(/Idempotency-Key/i);
        });

        it('should return 400 Bad Request if Idempotency-Key header is empty or pure whitespace', async () => {
            const res = await request(app)
                .post('/payments')
                .set('Idempotency-Key', '   ')
                .send({ amount: 2000, currency: 'USD' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('should return 400 Bad Request if Idempotency-Key header contains internal whitespace or spaces', async () => {
            const res = await request(app)
                .post('/payments')
                .set('Idempotency-Key', 'invalid key with spaces')
                .send({ amount: 2000, currency: 'USD' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });
    });

    describe('GET /payments/:id', () => {
        it('should return 200 OK and payment data for existing payment', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 4500, currency: 'GBP' });

            const paymentId = createRes.body.data.id;

            const getRes = await request(app).get(`/payments/${paymentId}`);

            expect(getRes.status).toBe(200);
            expect(getRes.body.success).toBe(true);
            expect(getRes.body.data.id).toBe(paymentId);
            expect(getRes.body.data.amount).toBe(4500);
            expect(getRes.body.data.currency).toBe('GBP');
        });

        it('should return 404 Not Found for non-existent payment ID', async () => {
            const res = await request(app).get('/payments/non-existent-id');

            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PATCH /payments/:id/status (Protected Operator Endpoint)', () => {
        describe('Authentication & Authorization', () => {
            it('should return 401 Unauthorized if X-Admin-Api-Key header is missing', async () => {
                const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

                const createRes = await request(app)
                    .post('/payments')
                    .send({ amount: 1000, currency: 'USD' });

                const id = createRes.body.data.id;

                const res = await request(app)
                    .patch(`/payments/${id}/status`)
                    .send({ status: 'PROCESSING' });

                expect(res.status).toBe(401);
                expect(res.body.success).toBe(false);
                expect(res.body.error.code).toBe('UNAUTHORIZED');
                expect(res.body.error.message).toBe('Missing or invalid admin API key');

                // Verify log happened without leaking the secret key
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('missing or empty X-Admin-Api-Key header')
                );
                expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(ADMIN_KEY));

                warnSpy.mockRestore();
            });

            it('should return 401 Unauthorized if X-Admin-Api-Key is invalid and log attempt without key', async () => {
                const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
                const badKey = 'attacker-attempt-key-123';

                const createRes = await request(app)
                    .post('/payments')
                    .send({ amount: 1000, currency: 'USD' });

                const id = createRes.body.data.id;

                const res = await request(app)
                    .patch(`/payments/${id}/status`)
                    .set('X-Admin-Api-Key', badKey)
                    .send({ status: 'PROCESSING' });

                expect(res.status).toBe(401);
                expect(res.body.success).toBe(false);
                expect(res.body.error.code).toBe('UNAUTHORIZED');

                // Verify log warned about incorrect key WITHOUT logging badKey or ADMIN_KEY
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('incorrect X-Admin-Api-Key')
                );
                const loggedCalls = warnSpy.mock.calls.map(c => c.join(' ')).join(' ');
                expect(loggedCalls).not.toContain(badKey);
                expect(loggedCalls).not.toContain(ADMIN_KEY);

                warnSpy.mockRestore();
            });

            it('should reject x-api-key header and return 401 Unauthorized', async () => {
                const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

                const createRes = await request(app)
                    .post('/payments')
                    .send({ amount: 1000, currency: 'USD' });

                const id = createRes.body.data.id;

                const res = await request(app)
                    .patch(`/payments/${id}/status`)
                    .set('x-api-key', ADMIN_KEY)
                    .send({ status: 'PROCESSING' });

                expect(res.status).toBe(401);
                expect(res.body.error.code).toBe('UNAUTHORIZED');

                warnSpy.mockRestore();
            });

            it('should reject Authorization: Bearer header and return 401 Unauthorized', async () => {
                const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

                const createRes = await request(app)
                    .post('/payments')
                    .send({ amount: 1000, currency: 'USD' });

                const id = createRes.body.data.id;

                const res = await request(app)
                    .patch(`/payments/${id}/status`)
                    .set('Authorization', `Bearer ${ADMIN_KEY}`)
                    .send({ status: 'PROCESSING' });

                expect(res.status).toBe(401);
                expect(res.body.error.code).toBe('UNAUTHORIZED');

                warnSpy.mockRestore();
            });

            it('should return 401 Unauthorized if X-Admin-Api-Key is an empty string', async () => {
                const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

                const createRes = await request(app)
                    .post('/payments')
                    .send({ amount: 1000, currency: 'USD' });

                const id = createRes.body.data.id;

                const res = await request(app)
                    .patch(`/payments/${id}/status`)
                    .set('X-Admin-Api-Key', '')
                    .send({ status: 'PROCESSING' });

                expect(res.status).toBe(401);
                expect(res.body.success).toBe(false);
                expect(res.body.error.code).toBe('UNAUTHORIZED');
                expect(res.body.error.message).toBe('Missing or invalid admin API key');

                warnSpy.mockRestore();
            });

            it('should return 401 Unauthorized if X-Admin-Api-Key is whitespace', async () => {
                const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

                const createRes = await request(app)
                    .post('/payments')
                    .send({ amount: 1000, currency: 'USD' });

                const id = createRes.body.data.id;

                const res = await request(app)
                    .patch(`/payments/${id}/status`)
                    .set('X-Admin-Api-Key', '   ')
                    .send({ status: 'PROCESSING' });

                expect(res.status).toBe(401);
                expect(res.body.success).toBe(false);
                expect(res.body.error.code).toBe('UNAUTHORIZED');

                warnSpy.mockRestore();
            });

            it('should allow POST /payments without an API key', async () => {
                const res = await request(app)
                    .post('/payments')
                    .send({ amount: 5000, currency: 'USD' });

                expect(res.status).toBe(201);
                expect(res.body.success).toBe(true);
                expect(res.body.data.amount).toBe(5000);
                expect(res.body.data.currency).toBe('USD');
                expect(res.body.data.status).toBe('PENDING');
            });

            it('should allow GET /payments/:id without an API key', async () => {
                const createRes = await request(app)
                    .post('/payments')
                    .send({ amount: 7500, currency: 'EUR' });

                const id = createRes.body.data.id;

                const getRes = await request(app).get(`/payments/${id}`);

                expect(getRes.status).toBe(200);
                expect(getRes.body.success).toBe(true);
                expect(getRes.body.data.id).toBe(id);
                expect(getRes.body.data.amount).toBe(7500);
            });

            it('should authenticate successfully with X-Admin-Api-Key header', async () => {
                const createRes = await request(app)
                    .post('/payments')
                    .send({ amount: 1000, currency: 'USD' });

                const id = createRes.body.data.id;

                const res = await request(app)
                    .patch(`/payments/${id}/status`)
                    .set('X-Admin-Api-Key', ADMIN_KEY)
                    .send({ status: 'PROCESSING' });

                expect(res.status).toBe(200);
                expect(res.body.data.status).toBe('PROCESSING');
            });
        });

        it('should transition status from PENDING to PROCESSING and return 200 OK', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'USD' });

            const id = createRes.body.data.id;

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.id).toBe(id);
            expect(res.body.data.status).toBe('PROCESSING');
            expect(res.body.data.history).toHaveLength(2);
            expect(res.body.data.history[1].status).toBe('PROCESSING');
        });

        it('should support PUT /payments/:id/status as well', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'USD' });

            const id = createRes.body.data.id;

            const res = await request(app)
                .put(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING' });

            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('PROCESSING');
        });

        it('should transition status from PROCESSING to SUCCESS', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 2000, currency: 'EUR' });

            const id = createRes.body.data.id;
            await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING' });

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'SUCCESS' });

            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('SUCCESS');
            expect(res.body.data.history).toHaveLength(3);
        });

        it('should transition status from PROCESSING to FAILED when valid failureReason is provided', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 3000, currency: 'NGN' });

            const id = createRes.body.data.id;
            await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING' });

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'FAILED', failureReason: 'Card expired' });

            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('FAILED');
            expect(res.body.data.failureReason).toBe('Card expired');
        });

        it('should return 400 Bad Request if status is FAILED but failureReason is missing', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'NGN' });

            const id = createRes.body.data.id;
            await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING' });

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'FAILED' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('should return 400 Bad Request if failureReason is provided for non-FAILED status', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'NGN' });

            const id = createRes.body.data.id;

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING', failureReason: 'Not allowed here' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('should return 409 Conflict on illegal state transition (PENDING -> SUCCESS)', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'NGN' });

            const id = createRes.body.data.id;

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'SUCCESS' });

            expect(res.status).toBe(409);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('CONFLICT');
        });

        it('should return 409 Conflict if expectedStatus does not match current payment status', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'NGN' });

            const id = createRes.body.data.id;

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING', expectedStatus: 'SUCCESS' });

            expect(res.status).toBe(409);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('CONFLICT');
        });

        it('should succeed when expectedStatus matches current payment status', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'NGN' });

            const id = createRes.body.data.id;

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING', expectedStatus: 'PENDING' });

            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('PROCESSING');
        });

        it('should return 404 Not Found if payment ID does not exist', async () => {
            const res = await request(app)
                .patch('/payments/non-existent-id/status')
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'PROCESSING' });

            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('NOT_FOUND');
        });

        it('should return 400 Bad Request on invalid status value', async () => {
            const createRes = await request(app)
                .post('/payments')
                .send({ amount: 1000, currency: 'NGN' });

            const id = createRes.body.data.id;

            const res = await request(app)
                .patch(`/payments/${id}/status`)
                .set('x-admin-api-key', ADMIN_KEY)
                .send({ status: 'INVALID_STATUS' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });
    });

    describe('404 Handling', () => {
        it('should return 404 Not Found on undefined routes', async () => {
            const res = await request(app).get('/unknown-endpoint');

            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('ADMIN_API_KEY Startup Validation', () => {
        it('should fail at startup if ADMIN_API_KEY is unset or empty in loadConfig', () => {
            expect(() => loadConfig({})).toThrow("Fatal: Required environment variable 'ADMIN_API_KEY' is unset.");
            expect(() => loadConfig({ ADMIN_API_KEY: '' })).toThrow("Fatal: Required environment variable 'ADMIN_API_KEY' is unset.");
            expect(() => loadConfig({ ADMIN_API_KEY: '   ' })).toThrow("Fatal: Required environment variable 'ADMIN_API_KEY' is unset.");
        });

        it('should load successfully when ADMIN_API_KEY is provided in loadConfig', () => {
            const cfg = loadConfig({ ADMIN_API_KEY: 'valid-key', PORT: '4000', FILE_STORAGE: './custom.json' });
            expect(cfg.adminApiKey).toBe('valid-key');
            expect(cfg.port).toBe(4000);
            expect(cfg.fileStorage).toBe('./custom.json');
        });

        it('should parse worker options from environment in loadConfig', () => {
            const cfg = loadConfig({
                ADMIN_API_KEY: 'valid-key',
                WORKER_POLL_INTERVAL_MS: '2500',
                WORKER_CONCURRENCY: '5',
                WORKER_MAX_RETRIES: '4',
                WORKER_INITIAL_RETRY_DELAY_MS: '150',
                WORKER_RETRY_BACKOFF_FACTOR: '3',
                WORKER_MAX_RETRY_DELAY_MS: '8000',
                WORKER_ENABLE_JITTER: 'false',
                WORKER_STALE_PROCESSING_TIMEOUT_MS: '60000',
                WORKER_BANK_LATENCY_MS: '75',
            });

            expect(cfg.worker.pollIntervalMs).toBe(2500);
            expect(cfg.worker.concurrency).toBe(5);
            expect(cfg.worker.maxRetries).toBe(4);
            expect(cfg.worker.initialRetryDelayMs).toBe(150);
            expect(cfg.worker.retryBackoffFactor).toBe(3);
            expect(cfg.worker.maxRetryDelayMs).toBe(8000);
            expect(cfg.worker.enableJitter).toBe(false);
            expect(cfg.worker.staleProcessingTimeoutMs).toBe(60000);
            expect(cfg.worker.bankLatencyMs).toBe(75);
        });

        it('should fail at startup if createApp is invoked without adminApiKey and process.env is unset', () => {
            const originalKey = process.env.ADMIN_API_KEY;
            delete process.env.ADMIN_API_KEY;

            try {
                expect(() => createApp(repo)).toThrow("Fatal: Required environment variable 'ADMIN_API_KEY' is unset.");
            } finally {
                if (originalKey) {
                    process.env.ADMIN_API_KEY = originalKey;
                }
            }
        });
    });

    describe('Global Error Handling & Payload Limits', () => {
        it('should return 400 Bad Request with consistent shape when given malformed JSON syntax ({bad)', async () => {
            const res = await request(app)
                .post('/payments')
                .set('Content-Type', 'application/json')
                .send('{bad');

            expect(res.status).toBe(400);
            expect(res.body).toEqual({
                success: false,
                error: {
                    code: 'INVALID_JSON',
                    message: 'Invalid JSON syntax in request body',
                },
            });
        });

        it('should return 413 Payload Too Large with consistent shape when body exceeds 10 KB', async () => {
            // Generate a payload exceeding 10 KB (10240 bytes)
            const largeData = 'x'.repeat(12 * 1024);
            const res = await request(app)
                .post('/payments')
                .set('Content-Type', 'application/json')
                .send(`{ "amount": 100, "currency": "USD", "extra": "${largeData}" }`);

            expect(res.status).toBe(413);
            expect(res.body).toEqual({
                success: false,
                error: {
                    code: 'PAYLOAD_TOO_LARGE',
                    message: 'Payload too large. Maximum allowed size is 10kb.',
                },
            });
        });

        it('should return 500 Internal Server Error with consistent shape including success: false', async () => {
            // Suppress console.error for expected 500 simulation
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            // Force repo.findById to throw an unexpected non-AppError
            jest.spyOn(repo, 'findById').mockRejectedValueOnce(new Error('Unexpected disk read fault'));

            const res = await request(app).get('/payments/non-existent-uuid');

            expect(res.status).toBe(500);
            expect(res.body).toEqual({
                success: false,
                error: {
                    code: 'INTERNAL_ERROR',
                    message: 'Internal server error',
                },
            });

            consoleSpy.mockRestore();
        });
    });
});
