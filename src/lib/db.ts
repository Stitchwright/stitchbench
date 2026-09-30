import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Singleton on globalThis: Next.js dev mode hot-reloads modules, and a production build loads separate copies of this
// file for the pages, route handlers, actions and background timers. Each would otherwise make its own PrismaClient
// with its own pg pool, and the pools add up against Postgres' connection limit.
const globalForPrisma = globalThis as unknown as { db?: PrismaClient };

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const db = (globalForPrisma.db ??= createClient());
