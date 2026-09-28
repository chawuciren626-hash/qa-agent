import { defineConfig, devices } from "@playwright/test";

const runDir = process.env.QA_RUN_DIR ?? "output";

export default defineConfig({
  testDir: "./tests/generated",
  timeout: 30_000,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: `${runDir}/playwright/playwright-results.json` }],
    ["html", { outputFolder: `${runDir}/playwright/html-report`, open: "never" }]
  ],
  use: {
    baseURL: process.env.QA_BASE_URL,
    headless: process.env.QA_HEADED !== "true",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  outputDir: `${runDir}/playwright/test-artifacts`
});
