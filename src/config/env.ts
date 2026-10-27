import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DB_PATH: z.string().default("data/funding.sqlite"),
  DATA_DIR: z.string().default("data/vision"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().default(16),
  // Optional: only used to read the account's real fee tier.
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
export const env: Env = envSchema.parse(process.env);
