import { readFile } from "node:fs/promises";
import pg from "pg";
import { getDatabaseSsl } from "../api/lib/database.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Set it in the environment before running npm run db:migrate.");
}

const schema = await readFile(new URL("../supabase/migrations/20261103000000_accounts.sql", import.meta.url), "utf8");
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  ssl: getDatabaseSsl(databaseUrl),
});

try {
  await pool.query(schema);
  console.log("Fitness account database schema is ready.");
} finally {
  await pool.end();
}
