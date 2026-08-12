import 'dotenv/config';

import app from './app.js';
import { getAuthConfig } from './config/auth.config.js';
import { runMigrations } from './db/migrations.js';

const PORT = process.env.PORT || 3000;

getAuthConfig();

runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((error: unknown) => {
    console.error('Database migration failed', error);
    process.exitCode = 1;
  });