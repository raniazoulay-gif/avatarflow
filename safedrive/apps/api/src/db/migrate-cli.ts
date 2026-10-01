import { loadEnv } from '../config/env.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL, 2);
migrate(db)
  .then((applied) => {
    console.warn(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
    return db.end();
  })
  .catch(async (e: Error) => {
    console.error(e.message);
    await db.end();
    process.exit(1);
  });
