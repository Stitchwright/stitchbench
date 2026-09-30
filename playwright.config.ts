import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.ts", // tests/unit/*.test.ts belong to `npm run test:unit`
  // One file at a time, in order: the specs share the install's state (its one community hub connection, the partnerships
  // and the E2E shop's data), and hub.spec leaves and re-joins the hub while others need it.
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  // dev server compiles pages on first visit, which can take several seconds
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    viewport: { width: 1400, height: 1000 },
    // PW_CHANNEL=chrome uses the installed Google Chrome instead of downloading a browser.
    channel: process.env.PW_CHANNEL || undefined,
    launchOptions: { args: process.env.PW_ARGS ? process.env.PW_ARGS.split(" ") : [] },
  },
});
