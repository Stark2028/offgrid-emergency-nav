import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Tile, TileSet } from '@offgrid/core';
import { WalkingNetwork } from '@offgrid/maps';
import { pickMapPoints } from './map-test-points.mjs';

process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');

const app = 'org.offgrid.navigation';
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk');
const adbPath = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' }).split('\n').filter(l => l.includes('\tdevice')).map(l => l.split('\t')[0]);
const serial = process.env.OFFGRID_ADB_SERIAL ?? (devices.length === 1 ? devices[0] : undefined);
if (!serial || !serial.startsWith('emulator-')) throw new Error('This automated test changes emulator connectivity. Select an emulator with OFFGRID_ADB_SERIAL; use the field checklist for a personal phone.');
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(import.meta.dirname, '..');
const captures = resolve(root, '../../.impeccable/review');
await mkdir(captures, { recursive: true });
const isAppPage = page => {
  const url = page.url();
  return url.startsWith('https://localhost') || url.startsWith('http://localhost') || url.startsWith('capacitor://localhost');
};
async function capture(name) { await writeFile(resolve(captures, `${name}.png`), execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 30000 })); }
async function connect() {
  adb('shell', 'am', 'start', '-n', `${app}/.MainActivity`);
  for (let attempt = 0; attempt < 75; attempt++) {
    try {
      const pid = adb('shell', 'pidof', app).trim();
      adb('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`);
      const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 3000 });
      for (let poll = 0; poll < 8; poll++) {
        const page = browser.contexts().flatMap(context => context.pages()).find(isAppPage);
        if (page) return { browser, page };
        await delay(500);
      }
      await browser.close();
    } catch { /* WebView creates its socket shortly after the activity. */ }
    await delay(1000);
  }
  throw new Error('The Android WebView did not become available.');
}
function routePoints() {
  const catalogue = JSON.parse(readFileSync(resolve(root, 'src/generated/catalog.json')));
  const region = catalogue.regions.find(r => r.id === 'south-delhi');
  const folder = resolve(root, 'public', region.manifestUrl.slice(1), '..');
  const manifest = JSON.parse(readFileSync(resolve(folder, 'manifest.json'))), tiles = new TileSet();
  for (const asset of manifest.assets.filter(a => a.kind === 'routing-tile')) tiles.add(new Tile(Uint8Array.from(readFileSync(resolve(folder, asset.path))).buffer));
  const network = new WalkingNetwork(tiles), [w,s,e,n] = region.bounds;
  const edge = network.edges.find(edge => edge.metres > 100 && edge.points.every(([lon,lat]) => lon>w && lon<e && lat>s && lat<n));
  return { bounds: region.bounds, points: [edge.points[0], edge.points.at(-1)] };
}
let browser;
try {
  adb('install', '-r', resolve(root, 'android/app/build/outputs/apk/debug/app-debug.apk'));
  adb('shell','pm','clear',app);
  let connection = await connect(); browser = connection.browser;
  let page = connection.page;
  await expect(page.getByRole('heading',{name:'Find your offline area.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Install app'})).toHaveCount(0);
  await page.getByRole('button',{name:/South Delhi Hauz Khas/}).click();
  await page.getByRole('button',{name:/Save this area/}).click();
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible({timeout:60000});
  if (!adb('shell','run-as',app,'ls','databases').includes('offline-maps.db')) throw new Error('Native SQLite map database was not created.');
  await capture('android-library');
  adb('shell','am','force-stop',app);
  adb('shell','cmd','connectivity','airplane-mode','enable');
  adb('shell','svc','wifi','disable');
  connection = await connect(); browser = connection.browser; page = connection.page;
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible({timeout:60000});
  await page.getByRole('button',{name:'Check offline files'}).click();
  await expect(page.getByText(/Offline file check passed/)).toBeVisible();
  await page.getByRole('button',{name:'Open walking navigation'}).click();
  await expect(page.getByRole('heading',{name:'Where are you heading?'})).toBeVisible();
  const {bounds,points} = routePoints();
  await pickMapPoints(page,bounds,points);
  await page.getByRole('button',{name:'Find walking route',exact:true}).click();
  await expect(page.locator('.route-summary')).toBeVisible({timeout:30000});
  await expect(page.locator('.navigation-map')).toHaveAttribute('data-route-ready','true');
  await capture('android-route-offline');
  // Native Back must unwind the navigation screen, retaining the saved map.
  adb('shell','input','keyevent','4');
  await expect(page.getByRole('heading',{name:'Hauz Khas & Green Park'})).toBeVisible();
  adb('shell','settings','put','system','font_scale','1.3');
  adb('shell','cmd','uimode','night','yes');
  await delay(1500); await capture('android-large-text');
  console.log('Android smoke passed: private SQLite storage, force-stop recovery, offline verification/routing, native Back, and large-text capture.');
} finally {
  adb('shell','settings','put','system','font_scale','1.0');
  adb('shell','cmd','uimode','night','no');
  adb('shell','cmd','connectivity','airplane-mode','disable');
  adb('shell','svc','wifi','enable');
  adb('forward','--remove','tcp:9223');
  await browser?.close();
}
