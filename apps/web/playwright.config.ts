import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// Corporate/tool proxies must not intercept readiness checks for our own server.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");

export default defineConfig({
  testDir: "./e2e",
  timeout: 40000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: process.env.OFFGRID_BROWSER_CHANNEL ?? (process.env.CI || process.platform !== "win32" ? undefined : "chrome"),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], defaultBrowserType: "chromium", channel: process.env.OFFGRID_BROWSER_CHANNEL ?? (process.env.CI || process.platform !== "win32" ? undefined : "chrome") } },
  ],
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    cwd: import.meta.dirname,
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  outputDir: resolve(import.meta.dirname, "test-results"),
});
