import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 180_000,
  // dev server compiles pages on first visit, which can take several seconds
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    viewport: { width: 1400, height: 1000 },
    // PW_CHANNEL=chrome uses the installed Google Chrome instead of downloading a browser.
    channel: process.env.PW_CHANNEL || undefined,
  },
});
