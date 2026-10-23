export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export class Logger {
    private level: LogLevel;

    constructor(private context: string = 'App', level?: LogLevel) {
        if (level) {
            this.level = level;
        } else if (process.env.DEBUG || process.env.DEBUG_WORKER) {
            this.level = 'debug';
        } else if (process.env.LOG_LEVEL) {
            this.level = (process.env.LOG_LEVEL.toLowerCase() as LogLevel) || 'info';
        } else if (process.env.NODE_ENV === 'test') {
            this.level = 'warn';
        } else {
            this.level = 'info';
        }
    }

    private shouldLog(level: LogLevel): boolean {
        return LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS[this.level];
    }

    private format(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
        const timestamp = new Date().toISOString();
        const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
        return `[${timestamp}] [${level.toUpperCase()}] [${this.context}] ${message}${metaStr}`;
    }

    info(message: string, meta?: Record<string, unknown>): void {
        if (this.shouldLog('info')) {
            console.log(this.format('info', message, meta));
        }
    }

    debug(message: string, meta?: Record<string, unknown>): void {
        if (this.shouldLog('debug')) {
            console.log(this.format('debug', message, meta));
        }
    }

    warn(message: string, meta?: Record<string, unknown>): void {
        if (this.shouldLog('warn')) {
            console.warn(this.format('warn', message, meta));
        }
    }

    error(message: string, errOrMeta?: unknown): void {
        if (this.shouldLog('error')) {
            if (errOrMeta instanceof Error) {
                console.error(this.format('error', `${message} - ${errOrMeta.message}`), errOrMeta.stack);
            } else if (typeof errOrMeta === 'object' && errOrMeta !== null) {
                console.error(this.format('error', message, errOrMeta as Record<string, unknown>));
            } else {
                console.error(this.format('error', message));
            }
        }
    }

    child(context: string): Logger {
        return new Logger(context, this.level);
    }
}

export const logger = new Logger('App');
