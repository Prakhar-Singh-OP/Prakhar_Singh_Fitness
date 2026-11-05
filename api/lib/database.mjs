import { readFileSync } from "node:fs";

const supabaseCa = readFileSync(new URL("../../supabase/prod-ca-2021.crt", import.meta.url), "utf8");

export function getDatabaseSsl(databaseUrl) {
  if (!databaseUrl) return undefined;

  const hostname = new URL(databaseUrl).hostname;
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return undefined;

  return { rejectUnauthorized: true, ca: supabaseCa };
}
