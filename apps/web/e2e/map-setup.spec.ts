import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

test("choose coverage, download, reopen offline, check files, and remove", async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: /New Delhi Connaught Place/ }).click();
  await expect(page.getByRole("heading", { name: "Find your offline area." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connaught Place" })).toBeVisible();
  await page.getByLabel("Search city or area").fill("South Delhi");
  await expect(page.getByRole("button", { name: /South Delhi Hauz Khas/ })).toBeVisible();
  await page.getByRole("button", { name: /South Delhi Hauz Khas/ }).click();
  await expect(page.getByRole("heading", { name: "Hauz Khas & Green Park" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: /New Delhi Connaught Place/ }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const captures = resolve(import.meta.dirname, "../../../.impeccable/review");
  await mkdir(captures, { recursive: true });
  await page.screenshot({ path: resolve(captures, `${testInfo.project.name}.png`), fullPage: true });
  await page.getByRole("button", { name: /Download this area/ }).click();
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Check offline files" })).toBeEnabled();
  await context.setOffline(true);
  await page.reload();
  // Startup re-verifies the saved files. Shared CI CPUs can also be compiling
  // the map shaders; wait for readiness instead of the default five seconds.
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Check offline files" }).click();
  await expect(page.getByText(/Offline file check passed/)).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: resolve(captures, `${testInfo.project.name}-offline.png`), fullPage: true });
  await page.getByRole("button", { name: /Downloaded/ }).click();
  await expect(page.getByRole("button", { name: /New Delhi Connaught Place/ })).toBeVisible();
  await page.getByRole("button", { name: "Remove this area from this device" }).click();
  await page.getByRole("button", { name: "Remove map", exact: true }).click();
  await expect(page.getByText("Your first map starts here.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download this area/ })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("a damaged map cannot become installed, and retry repairs it", async ({ page, context }) => {
  await context.route("**/packs/**/map.json", (route) => route.fulfill({ status: 200, body: "damaged map", contentType: "application/json" }));
  await page.goto("/");
  await page.getByRole("button", { name: /New Delhi Connaught Place/ }).click();
  await page.getByRole("button", { name: /Download this area/ }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Saved on this device", { exact: true })).not.toBeVisible();
  await context.unroute("**/packs/**/map.json");
  await page.getByRole("button", { name: /Resume download/ }).click();
  await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible({ timeout: 20000 });
});

test("location is requested on demand and only recommends actual coverage", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 28.632, longitude: 77.216, accuracy: 20 });
  await page.goto("/");
  await page.getByRole("button", { name: /New Delhi Connaught Place/ }).click();
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.getByText(/Showing the area around your location/)).toBeVisible();
  await context.setGeolocation({ latitude: 19.076, longitude: 72.8777 });
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.getByText(/outside the available starter areas/)).toBeVisible();
  const feedback = page.getByRole("status").filter({ hasText: /outside the available starter areas/ });
  await expect(feedback).toBeVisible();
  const buttonBox = await page.getByRole("button", { name: "Use my location" }).boundingBox();
  const messageBox = await feedback.boundingBox();
  expect(messageBox!.y - buttonBox!.y).toBeLessThan(90);
  await expect(page.getByRole("heading", { name: "Connaught Place" })).toBeVisible();
});

test("pause persists real browser progress and resume requests the remaining range", async ({ page, context }) => {
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await page.goto("/");
  await page.getByRole("button", { name: /New Delhi Connaught Place/ }).click();
  await client.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: 20 * 1024, uploadThroughput: -1 });
  const ranges: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("map.json") && request.headers()["range"]) ranges.push(request.headers()["range"]!); });
  await page.getByRole("button", { name: /Download this area/ }).click();
  await expect.poll(async () => Number((await page.locator(".download-progress strong").textContent() ?? "0").replace("%", ""))).toBeGreaterThan(10);
  await page.getByRole("button", { name: "Pause download" }).click();
  await expect(page.getByRole("button", { name: /Resume download/ })).toBeEnabled();
  await client.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.getByRole("button", { name: /Resume download/ }).click();
  await expect(page.getByRole("button", { name: "Check offline files" })).toBeEnabled({ timeout: 20000 });
  expect(ranges.length).toBeGreaterThan(0);
});
