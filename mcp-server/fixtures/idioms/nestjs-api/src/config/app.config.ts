export const appConfig = () => ({
  databaseUrl: process.env.DATABASE_URL,
  logLevel: process.env.LOG_LEVEL || 'info',
});
