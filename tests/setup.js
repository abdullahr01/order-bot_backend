// Loaded before application imports. Never load the developer's private .env.
import { fileURLToPath } from 'node:url';

process.env.DOTENV_CONFIG_PATH = fileURLToPath(new URL('./fixtures/unused.env', import.meta.url));
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.NODE_ENV = 'test';
process.env.PORT = '4000';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable';
process.env.SUPABASE_SECRET_KEY = 'test-secret';
process.env.CORS_ORIGINS = [3000, 3001, 3002, 3003].map((port) => `http://localhost:${port}`).join(',');
process.env.LOG_LEVEL = 'info';
