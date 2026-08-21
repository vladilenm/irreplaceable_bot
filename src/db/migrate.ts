import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createPool } from './pool.js';
import { runMigrations } from './migrations.js';

export async function migrateDatabase(): Promise<number> {
  const pool = createPool(config.database, config.database.migrationUrl);
  try {
    return await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile === currentFile) {
  void migrateDatabase()
    .then((applied) => {
      logger.info({ appliedMigrations: applied }, 'PostgreSQL migrations complete');
    })
    .catch((error: unknown) => {
      logger.fatal(
        { errorClass: error instanceof Error ? error.name : 'unknown' },
        'PostgreSQL migrations failed',
      );
      process.exitCode = 1;
    });
}
