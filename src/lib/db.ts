import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Singleton: Next.js dev mode hot-reloads modules, which would otherwise
// create a new PrismaClient (and a new pg pool) on every reload.
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

export const db = globalForPrisma.db ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.db = db;
}
