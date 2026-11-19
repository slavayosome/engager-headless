import { defineConfig } from "drizzle-kit";

// Load .env (Node 25 native loader) so DATABASE_URL is available to drizzle-kit.
try {
  (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(".env");
} catch {
  /* no .env — rely on the ambient environment */
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/database/schema.ts",
  out: "./packages/database/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
