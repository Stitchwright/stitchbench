import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    // For the drift check only (`prisma migrate diff --from-migrations`): an empty scratch database, e.g.
    // postgresql://stitchbench:stitchbench@localhost:5433/stitchbench_shadow. Not needed to run the app.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
