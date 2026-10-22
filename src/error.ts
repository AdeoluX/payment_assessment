export class AppError extends Error {
    constructor(
        public statusCode: number,
        public code: string,
        message: string,
        public details?: unknown
    ) {
        super(message);
        this.name = new.target.name
    }
}

export class ValidationError extends AppError {
    constructor(message = 'Invalid request', details?: unknown) {
        super(400, 'VALIDATION_ERROR', message, details)
    }
}

export class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(404, 'NOT_FOUND', message)
    }
}

export class ConflictError extends AppError {
    constructor(message = 'Conflict', details?: unknown) {
        super(409, 'CONFLICT', message, details);
    }
}

export class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized', details?: unknown) {
        super(401, 'UNAUTHORIZED', message, details);
    }
}