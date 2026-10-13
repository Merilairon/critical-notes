import { defineConfig } from 'drizzle-kit';

/** Migrations for the Postgres mirror of the schema (`pnpm db:generate` writes both dialects). */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.pg.ts',
  out: './drizzle-pg',
});
