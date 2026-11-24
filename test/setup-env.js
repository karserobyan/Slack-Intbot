import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Imported first by test.js so it runs before any `dotenv/config`: the suite
// must not see a developer's .env or ambient overrides.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('INTBOT_')) delete process.env[key];
}
for (const key of ['CACHE_TTL_MS', 'CACHE_MIN_MS', 'CARD_TTL_MS', 'DOTENV_KEY']) delete process.env[key];
process.env.DOTENV_CONFIG_PATH = join(tmpdir(), 'intbot-test-no-such-dir', '.env');
