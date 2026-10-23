# Payment Assessment Service

A resilient asynchronous payment processing service built with **Node.js**, **Express**, **TypeScript**, and **Zod** as an assessment prototype.

The system decouples fast HTTP payment ingestion from asynchronous downstream bank execution. It features atomic storage persistence, optimistic concurrency control, an asynchronous background worker with exponential backoff and full jitter, two-phase startup reconciliation to mitigate double-charging, and constant-time timing-safe administrative authentication.

---

## 1. Overview & Setup

### Architecture Overview
1. **HTTP Ingestion (`POST /payments`)**: Clients create payment requests. Requests are validated with Zod, assigned an immutable UUID, stamped with `PENDING` status, and written to durable storage before returning immediately.
2. **Background Execution (`PaymentWorker`)**: An asynchronous worker polls for `PENDING` payments, claims them atomically (`PENDING` $\rightarrow$ `PROCESSING`) using optimistic concurrency, and communicates with a bank gateway.
3. **Resilience & Retries**:
   - **Transient errors** (network timeouts, gateway 503s) trigger exponential backoff with full jitter up to `WORKER_MAX_RETRIES`.
   - **Terminal failures** (insufficient funds, expired cards) short-circuit immediately without wasting retries or sleeping.
4. **Crash Recovery**: On reboot, stranded `PROCESSING` payments undergo two-phase reconciliation: the worker queries the bank first via the idempotency key (`inquire`) to verify if the charge was previously captured before retrying.

### How the Worker Runs
The background worker (`PaymentWorker`) runs directly inside the same Node.js process as the Express API server:
- **In-Process Lifecycle**: In [`src/server.ts`](src/server.ts), during the bootstrap phase, `worker.start()` is invoked before `app.listen()` binds the HTTP port.
- **Startup Recovery**: On start, the worker first executes a recovery sweep for any `PROCESSING` payments that were left stranded by an unexpected shutdown or crash, querying the bank gateway (`inquire`) to reconcile state before charging.
- **Event-Driven Polling**: The worker then schedules a recursive timer-based polling loop (`scheduleNextPoll`) to query `JsonPaymentRepo` for `PENDING` records at intervals defined by `WORKER_POLL_INTERVAL_MS`, adhering to `WORKER_CONCURRENCY` limits.
- **Graceful Shutdown**: When `server.ts` receives termination signals (`SIGTERM` / `SIGINT`), it coordinates two-phase teardown: first stopping incoming HTTP traffic via `server.close()`, then awaiting `worker.stop()` to drain active in-flight bank requests and abort sleep timers.

### Prerequisites
- **Node.js**: `v18.0.0` or higher
- **npm**: `v9.0.0` or higher

### Environment Setup (`ADMIN_API_KEY` Required)
The service enforces a **fail-fast** security requirement: `ADMIN_API_KEY` must be configured at startup. If unset or empty, the application immediately aborts with:
```
Fatal: Required environment variable 'ADMIN_API_KEY' is unset.
```

### Installation & Running Locally
```bash
# 1. Install dependencies
npm install

# 2. Set the required admin API key
export ADMIN_API_KEY="super-secret-admin-key-12345"

# 3. Start development server (with tsx watch hot reload)
npm run dev

# Or build and run in production mode
npm run build
npm start
```

---

## 2. Configuration Table

All options are configurable via environment variables and parsed in [`src/config.ts`](src/config.ts):

| Variable | Type | Default | Description |
|---|---|---|---|
| `ADMIN_API_KEY` | `string` | **None (Required)** | **Required**. Secret key for administrative manual status updates via `X-Admin-Api-Key`. |
| `PORT` | `number` | `3000` | HTTP port for the Express application. |
| `FILE_STORAGE` | `string` | `./data/payments.json` | Path to the JSON database file. |
| `WORKER_POLL_INTERVAL_MS` | `number` | `1000` | Polling interval (in ms) for worker checking for `PENDING` jobs. |
| `WORKER_CONCURRENCY` | `number` | `3` | Maximum number of concurrent payments processed simultaneously. |
| `WORKER_MAX_RETRIES` | `number` | `3` | Maximum charge attempts before declaring terminal `FAILED`. |
| `WORKER_INITIAL_RETRY_DELAY_MS` | `number` | `100` | Initial exponential backoff delay in milliseconds. |
| `WORKER_RETRY_BACKOFF_FACTOR` | `number` | `2` | Multiplier factor applied to backoff delays on each subsequent attempt. |
| `WORKER_MAX_RETRY_DELAY_MS` | `number` | `5000` | Maximum cap (in ms) on any individual backoff delay. |
| `WORKER_ENABLE_JITTER` | `boolean` | `true` | Enables AWS-style Full Jitter (`Math.random() * delay`) to prevent thundering herd. Set to `false` to disable. |
| `WORKER_STALE_PROCESSING_TIMEOUT_MS` | `number` | `0` | Minimum age (in ms) before a stranded `PROCESSING` payment is recovered. `0` reconciles all stranded jobs on boot. |
| `WORKER_BANK_LATENCY_MS` | `number` | `50` | Simulated latency (in ms) of the default mock bank gateway. |
| `DEBUG_WORKER` | `boolean` | `false` | When set to `true`, emits structured JSON telemetry events to stdout. |

---

## 3. API Reference & `curl` Examples

### Unified Response Format
All `/payments` endpoints return responses enclosed in a strict, uniform JSON envelope:

- **Success (`200 OK` / `201 Created`)**:
  ```json
  {
    "success": true,
    "data": { ... }
  }
  ```
- **Error (`400`, `401`, `404`, `409`, `413`, `500`)**:
  ```json
  {
    "success": false,
    "error": {
      "code": "ERROR_CODE",
      "message": "Human-readable explanation",
      "details": "..."
    }
  }
  ```

---

### 1. Storage & Liveness Health Check
Inspects file accessibility and directory write permissions required for atomic renames, returning standard `{ success, data }` envelopes.

```bash
curl -i -X GET http://localhost:3000/health
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "store": "ready"
  }
}
```

*(If storage is unmounted or read-only, returns `503 Service Unavailable` with `{"success": false, "error": {"code": "SERVICE_UNAVAILABLE", "message": "Storage is unready or unwritable", "details": {"status": "error", "store": "unready"}}}`)*

---

### 2. Create Payment
Creates a payment in `PENDING` state. Amounts must be positive integers in minor units (e.g., cents, pence, kobo) with a valid 3-letter alphabetical ISO-4217 currency code (e.g. `USD`, `NGN`, `EUR`, `GBP`). Supports optional client idempotency keys (1–255 printable ASCII characters without spaces).

```bash
curl -i -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: client-txn-88319" \
  -d '{
    "amount": 5000,
    "currency": "USD"
  }'
```

**Response (`201 Created` on first submission):**
```json
{
  "success": true,
  "data": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "amount": 5000,
    "currency": "USD",
    "idempotencyKey": "client-txn-88319",
    "status": "PENDING",
    "history": [
      { "status": "PENDING", "at": "2026-10-22T21:40:00.123Z" }
    ],
    "createdAt": "2026-10-22T21:40:00.123Z",
    "updatedAt": "2026-10-22T21:40:00.123Z"
  }
}
```

*Note: Resubmitting the same request with the same `Idempotency-Key` returns `200 OK` with the existing payment record inside the `{ "success": true, "data": { ... } }` envelope. Resubmitting with the same key but different `amount` or `currency` returns `409 Conflict`.*

---

### 3. Get Payment by ID
Retrieves the payment and its full status transition history.

```bash
curl -i -X GET http://localhost:3000/payments/7c9e6679-7425-40de-944b-e07fc1f90ae7
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "amount": 5000,
    "currency": "USD",
    "idempotencyKey": "client-txn-88319",
    "status": "SUCCESS",
    "history": [
      { "status": "PENDING", "at": "2026-10-22T21:40:00.123Z" },
      { "status": "PROCESSING", "at": "2026-10-22T21:40:01.050Z" },
      { "status": "SUCCESS", "at": "2026-10-22T21:40:01.120Z" }
    ],
    "createdAt": "2026-10-22T21:40:00.123Z",
    "updatedAt": "2026-10-22T21:40:01.120Z"
  }
}
```

*(If the payment ID does not exist, returns `404 Not Found` with `{"success": false, "error": {"code": "NOT_FOUND", "message": "Payment ... not found"}}`)*

---

### 4. Update Payment Status (Admin Only)
Allows administrators to manually advance or resolve payment status.
- **Requires header**: `X-Admin-Api-Key: <ADMIN_API_KEY>` (verified using timing-safe SHA-256 comparisons).
- **Enforces strict transition DAG**: `PENDING` $\rightarrow$ `PROCESSING` $\rightarrow$ `SUCCESS` | `FAILED`. Terminal states cannot be altered.
- **Invariants**: `failureReason` is required when setting `FAILED`, and forbidden when setting `SUCCESS`.
- **Optimistic Concurrency**: Provide `"expectedStatus"` to guarantee no race conditions with active background workers.

#### Example A: Admin Marks Payment as `SUCCESS`
```bash
curl -i -X PATCH http://localhost:3000/payments/7c9e6679-7425-40de-944b-e07fc1f90ae7/status \
  -H "Content-Type: application/json" \
  -H "X-Admin-Api-Key: super-secret-admin-key-12345" \
  -d '{
    "status": "SUCCESS",
    "expectedStatus": "PROCESSING"
  }'
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "amount": 5000,
    "currency": "USD",
    "status": "SUCCESS",
    "history": [
      { "status": "PENDING", "at": "2026-10-22T21:40:00.123Z" },
      { "status": "PROCESSING", "at": "2026-10-22T21:40:01.050Z" },
      { "status": "SUCCESS", "at": "2026-10-22T21:40:02.400Z" }
    ],
    "createdAt": "2026-10-22T21:40:00.123Z",
    "updatedAt": "2026-10-22T21:40:02.400Z"
  }
}
```

#### Example B: Admin Marks Payment as `FAILED`
```bash
curl -i -X PATCH http://localhost:3000/payments/7c9e6679-7425-40de-944b-e07fc1f90ae7/status \
  -H "Content-Type: application/json" \
  -H "X-Admin-Api-Key: super-secret-admin-key-12345" \
  -d '{
    "status": "FAILED",
    "expectedStatus": "PROCESSING",
    "failureReason": "Manual admin dispute void"
  }'
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "amount": 5000,
    "currency": "USD",
    "status": "FAILED",
    "failureReason": "Manual admin dispute void",
    "history": [
      { "status": "PENDING", "at": "2026-10-22T21:40:00.123Z" },
      { "status": "PROCESSING", "at": "2026-10-22T21:40:01.050Z" },
      { "status": "FAILED", "at": "2026-10-22T21:40:02.400Z" }
    ],
    "createdAt": "2026-10-22T21:40:00.123Z",
    "updatedAt": "2026-10-22T21:40:02.400Z"
  }
}
```

---

### 5. Standard Error Responses
All errors across the entire API follow a consistent schema with `"success": false`:

| HTTP Status | Error Code (`error.code`) | Trigger Condition | Example Response |
|---|---|---|---|
| **`400 Bad Request`** | `VALIDATION_ERROR` | Amount $\le 0$, non-integer amounts, unsupported currency codes, invalid `Idempotency-Key` headers | `{"success": false, "error": {"code": "VALIDATION_ERROR", "message": "Invalid payload", "details": ...}}` |
| **`400 Bad Request`** | `INVALID_JSON` | Malformed JSON payload (e.g. `{bad`) | `{"success": false, "error": {"code": "INVALID_JSON", "message": "Invalid JSON syntax in request body"}}` |
| **`401 Unauthorized`** | `UNAUTHORIZED` | Missing or incorrect `X-Admin-Api-Key` on `/payments/:id/status` | `{"success": false, "error": {"code": "UNAUTHORIZED", "message": "Invalid or missing X-Admin-Api-Key"}}` |
| **`404 Not Found`** | `NOT_FOUND` | Unknown route or payment ID not found | `{"success": false, "error": {"code": "NOT_FOUND", "message": "Payment ... not found"}}` |
| **`409 Conflict`** | `CONFLICT` | Idempotency key reused with mismatched payload or invalid status transition | `{"success": false, "error": {"code": "CONFLICT", "message": "Idempotency key conflict: ..."}}` |
| **`413 Payload Too Large`** | `PAYLOAD_TOO_LARGE` | Request body exceeds 10 KB limit | `{"success": false, "error": {"code": "PAYLOAD_TOO_LARGE", "message": "Payload too large. Maximum allowed size is 10kb."}}` |
| **`500 Internal Error`** | `INTERNAL_ERROR` | Unexpected server error or disk fault | `{"success": false, "error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}}` |


---

## 4. Key Design Decisions

### 1. Ingestion / Execution Decoupling
By accepting payments as `PENDING` immediately and returning HTTP `201`, client HTTP latency is bounded by the fast local write path ($< 5\text{ ms}$) rather than downstream banking network latency ($100\text{ ms} - 5000\text{ ms}$). This insulates API callers from upstream payment gateway downtime.

### 2. Atomic Writes via Temp File Rename
`JsonPaymentRepo` never mutates the database file in place. Instead, it writes serialized JSON to a unique temporary file (`payments.json.<uuid>.tmp`) and invokes `fs.rename()`. On POSIX systems, `rename` is atomic, guaranteeing that a power loss or crash mid-write never leaves a partially written or corrupt database.

### 3. Fail-Fast Schema Validation on Boot
During `repo.init()`, the repository reads the entire storage file and validates every record against Zod's `storedPaymentsFileSchema`. If corrupted data or an invalid JSON structure is detected, the server refuses to open its port, preventing the service from operating on corrupt state.

### 4. Single-Writer Promise Queue with Memory Cache
To eliminate read-after-write inconsistencies and prevent disk race conditions, `JsonPaymentRepo` serializes write operations through an internal Promise Queue (`PromiseQueue`). Reads and idempotency checks are served in $O(1)$ time via an in-memory `Map` index that is updated only after disk writes succeed.

### 5. Optimistic Concurrency & Claiming
Multiple worker instances or processes can safely poll the same repository. A worker claims a job using `repo.update(payment.id, 'PENDING', { status: 'PROCESSING' })`. If another worker claims or an administrator updates the payment first, the update rejects with a `ConflictError`, causing the current worker to skip the payment cleanly without charging.

### 6. Constant-Time Timing-Safe Authentication
Rather than using standard string comparison (which is vulnerable to timing side-channel attacks), `requireAdminAuth` calculates the SHA-256 digest of both the configured key and incoming `X-Admin-Api-Key`, comparing them with Node's native `crypto.timingSafeEqual`.

### 7. Full Jitter Exponential Backoff
Downstream bank outages often recover simultaneously for multiple payments. Standard backoff causes synchronized retry spikes ("thundering herd"). Using AWS Full Jitter (`Math.random() * delay`) uniformly flattens retry distributions across time.

### 8. Two-Phase Crash Reconciliation (No Double-Charging)
When the worker starts, it searches for stranded `PROCESSING` payments from a prior crash. Instead of blindly re-charging the bank, it calls `bankGateway.inquire(payment.id, idempotencyKey)`:
- If the bank already recorded a `SUCCESS`, it updates locally to `SUCCESS` without calling `charge`.
- If unrecorded or transient, it proceeds safely with the charge flow.

---

## 5. Failure Modes & Mitigations

| Failure Scenario | How the System Handles It | Guarantees & Recovery |
|---|---|---|
| **Process crash while charging bank** | On startup, worker queries `bankGateway.inquire()` using payment ID. | Reconciles to `SUCCESS` if upstream bank recorded capture; note that the mock bank ledger is in-memory and resets on process restart (see Known Limitations). |
| **Transient bank error (timeout, 503)** | Worker identifies `isRetryable: true`, computes exponential backoff with full jitter, sleeps, and retries. | Prevents overwhelming upstream gateway; retries up to `WORKER_MAX_RETRIES` before marking `FAILED`. |
| **Terminal bank failure (insufficient funds, card expired)** | Gateway returns `isRetryable: false`. Worker immediately breaks out of retry loop. | **Zero wasted retries, never sleeps**: Marks payment `FAILED` immediately with specific bank reason. |
| **Concurrent workers polling same payment** | Conditional atomic update (`PENDING` $\rightarrow$ `PROCESSING`). | Exactly one worker succeeds; losing workers catch `ConflictError` and skip without charging. |
| **Client resubmits duplicate request** | In-memory `idempotencyIndex` looks up existing payment by idempotency key. | **Idempotent**: Returns existing record (`200 OK`). Reusing key with different amount/currency returns `409 Conflict`. |
| **SIGTERM / SIGINT during backoff sleep** | Worker aborts sleep immediately; leaves payment in `PROCESSING`. | Payment is **not** falsely marked `FAILED`. Reconciled cleanly on restart. |
| **Disk full / storage unwritable** | `repo.isReady()` checks directory write permissions; `/health` returns `503`. | Orchestrators (K8s/Docker) stop routing traffic before corrupted writes can occur. |
| **Corrupted JSON file on disk** | `repo.init()` runs Zod validation on startup. | **Fail-fast**: Aborts bootstrap with an explicit error before binding port. |
| **Timing attack on admin key** | Timing-safe comparison (`crypto.timingSafeEqual`) on SHA-256 digest. | Eliminates timing leaks regardless of key length or character differences. |

---

## 6. Testing

The project includes an automated test suite across **102 tests** covering unit, integration, and end-to-end scenarios.

```bash
# Run the entire test suite
npm test

# Run tests in watch mode
npm run test:watch

# Run only worker concurrency & backoff tests
npm test -- tests/paymentWorker.test.ts

# Type-check TypeScript without emitting JS
npx tsc --noEmit
```

### Test Suite Breakdown:
- [`tests/status.test.ts`](tests/status.test.ts): State machine DAG validation, legal vs illegal transitions, terminal state immutability.
- [`tests/jsonPaymentRepo.test.ts`](tests/jsonPaymentRepo.test.ts): Atomic file writes, idempotency enforcement, optimistic concurrency conflict handling, corruption fail-fast.
- [`tests/payments.api.test.ts`](tests/payments.api.test.ts): End-to-end HTTP tests, Zod validation errors, timing-safe authentication, health check readiness probe.
- [`tests/paymentWorker.test.ts`](tests/paymentWorker.test.ts): Background processing, concurrency limits, startup recovery & bank inquiry reconciliation, exponential backoff with full jitter, terminal error zero-sleep short-circuiting, multi-worker race conditions, and transient failure retries (2 sleeps, 3 charges).

---

## 7. Known Limitations & Production Path

### Known Limitations
1. **In-Memory Mock Bank Ledger**:
   - The bundled mock bank gateway stores transaction history in an in-memory `Map`. In this prototype, restarting the server process resets this mock bank ledger. Consequently, startup inquiry (`inquire()`) cannot discover charges captured before the restart unless backed by an external or persistent bank ledger.
2. **Admin `PROCESSING` Transition Stranding**:
   - If an administrator manually changes a payment status from `PENDING` to `PROCESSING` via `PATCH /payments/:id/status`, the running background worker will not process it (as its polling query only selects `PENDING` records). The payment remains stranded until the service restarts, at which point startup reconciliation sweeps orphaned `PROCESSING` payments.
3. **Embedded In-Process Worker**:
   - The background worker runs in the same Node.js event loop as the Express API server. Under sustained heavy load, intensive polling or processing shares CPU cycles with incoming HTTP request handling.
4. **Single-Node JSON Flat File Storage**:
   - While atomic temp-file renames and the in-process Promise Queue prevent race conditions and corrupted writes on a single host, local file storage does not support distributed horizontal scaling across multiple servers without a networked transactional database.

### Production Path
While this prototype is resilient and thoroughly tested, production cloud environments require additional scaling patterns:

1. **Storage Layer**:
   - *Current*: Local JSON file storage with POSIX atomic renames and in-memory indexes.
   - *Production*: Migrate to a relational database (PostgreSQL / CockroachDB) using row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED`) or distributed databases with transactional guarantees.
2. **Distributed Queue & Scheduling**:
   - *Current*: Periodic database polling (`findByStatus('PENDING')`).
   - *Production*: Adopt dedicated message queues (e.g., Redis Streams, BullMQ, AWS SQS, RabbitMQ) to eliminate polling overhead and enable push-based distributed task dispatching.
3. **Distributed Locking**:
   - *Current*: Single-node in-process Promise Queue.
   - *Production*: Implement Redis Redlock or Postgres advisory locks across multi-replica Kubernetes pods.
4. **Secrets & Authentication**:
   - *Current*: Single static `ADMIN_API_KEY` environment variable.
   - *Production*: Integrate OAuth2/OIDC, JWT tokens with RBAC (Role-Based Access Control), rate-limiting per API key, and automated secret rotation (AWS Secrets Manager, HashiCorp Vault).
5. **Observability & Distributed Tracing**:
   - *Current*: HTTP request logging middleware and structured worker event logs to stdout.
   - *Production*: Instrument OpenTelemetry traces propagating across HTTP requests and bank RPC calls, with Prometheus metrics (`payment_duration_seconds`, `retry_attempts_total`).

---

## 8. AI-Usage Note

This codebase, including its architecture, test suites, and documentation, was developed in collaboration with **Antigravity** (Google DeepMind). All state machine invariants, concurrency guards, timing-safe cryptographic comparisons, and backoff algorithms were designed to meet enterprise payment standards and rigorously validated through automated test coverage.
