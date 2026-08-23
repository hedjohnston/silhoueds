// Load .env if there is one, so `npm start` works without --env-file or a shell wrapper.
// Real environment variables always win: loadEnvFile does not overwrite what is already set.

import fs from 'node:fs';

const ENV_FILE = process.env.SILHOUEDS_ENV_FILE ?? '.env';

if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    console.warn(`Could not read ${ENV_FILE}: ${error.message}`);
  }
}
