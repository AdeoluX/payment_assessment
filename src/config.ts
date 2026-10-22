export interface AppConfig {
    port: number;
    fileStorage: string;
    adminApiKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const adminApiKey = env.ADMIN_API_KEY;
    if (!adminApiKey || adminApiKey.trim() === '') {
        throw new Error("Fatal: Required environment variable 'ADMIN_API_KEY' is unset.");
    }

    return {
        port: Number(env.PORT) || 3000,
        fileStorage: env.FILE_STORAGE || './data/payments.json',
        adminApiKey: adminApiKey.trim(),
    };
}
