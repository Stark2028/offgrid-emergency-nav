// Explicitly selected personal phone: no data clearing, permission grants,
// airplane mode, Wi-Fi changes, font changes, or fake GPS positions.
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Tile, TileSet } from '@offgrid/core';
import { WalkingNetwork } from '@offgrid/maps';
import { pickMapPoints } from './map-test-points.mjs';

process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');

const serial=process.env.OFFGRID_ADB_SERIAL;
if(!serial) throw new Error('Set OFFGRID_ADB_SERIAL to the explicitly authorized test phone.');
const sdk=process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA,'Android/Sdk');
const executable=join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb');
const adb=(...args)=>execFileSync(executable,['-s',serial,...args],{encoding:'utf8',timeout:60000});
if(adb('get-state').trim()!=='device') throw new Error('The selected phone is not authorized.');
const app='org.offgrid.navigation',root=resolve(import.meta.dirname,'..');
const output=resolve(root,'../../.impeccable/review');await mkdir(output,{recursive:true});
const report={model:adb('shell','getprop','ro.product.model').trim(),android:adb('shell','getprop','ro.build.version.release').trim(),startedAt:new Date().toISOString(),checks:{},warnings:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect() {
  adb('shell','am','start','-n',`${app}/.MainActivity`);
  let lastError;
  for(let attempt=0;attempt<30;attempt++) {
    try {
      const pid=adb('shell','pidof',app).trim();
      adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`);
      const browser=await chromium.connectOverCDP('http://127.0.0.1:9223',{timeout:2500});
      const context=browser.contexts()[0],page=context?.pages().find(p=>p.url().startsWith('https://localhost'));
      if(page) return {browser,context,page};
      await browser.close();
    } catch(error) { lastError=error; }
    await delay(1000);
  }
  throw new Error(`OFFGRID WebView did not become available: ${lastError?.message ?? 'no app target'}`);
}
async function capture(name) {
  const focus=adb('shell','dumpsys','window').split('\n').find(l=>l.includes('mCurrentFocus='));
  if(!focus?.includes(app)) throw new Error('OFFGRID is not in the foreground; refusing a personal-screen capture.');
  await writeFile(resolve(output,`samsung-${name}.png`),execFileSync(executable,['-s',serial,'exec-out','screencap','-p'],{timeout:30000}));
}
function publishedRoute() {
  const catalogue=JSON.parse(readFileSync(resolve(root,'src/generated/catalog.json'),'utf8'));
  const region=catalogue.regions.find(r=>r.id==='prayagraj-city');
  const folder=resolve(root,'public',region.manifestUrl.slice(1),'..');
  const manifest=JSON.parse(readFileSync(resolve(folder,'manifest.json'),'utf8')),tiles=new TileSet();
  for(const a of manifest.assets.filter(a=>a.kind==='routing-tile')) tiles.add(new Tile(Uint8Array.from(readFileSync(resolve(folder,a.path))).buffer));
  const network=new WalkingNetwork(tiles,region.bounds);
  for(const edge of network.edges.filter(e=>e.metres>200 && tiles.component(e.source)===0)) {
    const points=[edge.points[0],edge.points.at(-1)];
    try { network.plan(...points);return {region,points}; } catch { /* Choose unambiguous public fixture points. */ }
  }
  throw new Error('No route fixture was available.');
}
let browser;
try {
  let connection=await connect();browser=connection.browser;
  let {page}=connection;
  await expect(page.getByRole('heading',{name:'Find your offline area.'})).toBeVisible({timeout:30000});
  await expect(page.getByRole('button',{name:'Install app'})).toHaveCount(0);
  const nativeAvailable=await page.evaluate(()=>window.Capacitor?.isNativePlatform() && window.Capacitor?.isPluginAvailable('OfflineStorage'));
  if(!nativeAvailable) throw new Error('Native private storage bridge is not available.');
  report.checks.nativeBridge=true;
  console.log('OFFGRID native bridge is available.');
  await page.getByRole('button',{name:/Prayagraj City/}).click();
  const saved=page.getByText('Saved on this device',{exact:true});
  await page.waitForFunction(()=>document.querySelector('.area-state-ready') || [...document.querySelectorAll('button')].some(button=>/^(Save this area|Save map update|Resume saving)/.test(button.innerText) && !button.disabled),{},{timeout:60000});
  if(!await saved.isVisible()) {
    await page.getByRole('button',{name:/Save this area|Save map update|Resume saving/}).click();
    await expect(saved).toBeVisible({timeout:120000});
  }
  report.checks.prayagrajSaved=true;
  console.log('Prayagraj saved in native storage.');
  if(!adb('shell','run-as',app,'ls','databases').includes('offline-maps.db')) throw new Error('Native database is absent.');
  report.checks.privateDatabase=true;await capture('library');
  adb('shell','am','force-stop',app);
  connection=await connect();browser=connection.browser;page=connection.page;
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible({timeout:60000});
  report.checks.forceStopRecovery=true;
  console.log('Saved map survived app force-stop/reopening.');
  await page.getByRole('button',{name:'Check offline files'}).click();
  await expect(page.getByText(/Offline file check passed/)).toBeVisible({timeout:60000});
  report.checks.fileIntegrityCheck=true;await capture('reopened');
  await page.getByRole('button',{name:'Open walking navigation'}).click();
  await expect(page.getByRole('heading',{name:'Where are you heading?'})).toBeVisible();
  const {region,points}=publishedRoute();
  await pickMapPoints(page,region.bounds,points);
  await expect(page.getByRole('button',{name:'Find walking route',exact:true})).toBeEnabled({timeout:60000});
  // Only the app's WebView network is disabled. The personal phone keeps its
  // calls, Wi-Fi and mobile data; private SQLite and worker calculations remain.
  await connection.context.setOffline(true);
  await page.getByRole('button',{name:'Find walking route',exact:true}).click();
  await expect(page.locator('.route-summary')).toBeVisible({timeout:30000});
  await expect(page.locator('.navigation-map')).toHaveAttribute('data-route-ready','true');
  report.checks.webViewOfflineRouting=true;await capture('route');
  const root=page.locator('.navigation-map:not(.coverage-map)');
  await root.scrollIntoViewIfNeeded();
  const mapBox=await root.boundingBox();
  const markerDistance=async()=>{
    const a=await page.locator('.map-point-start').boundingBox(),b=await page.locator('.map-point-end').boundingBox();
    return Math.hypot(a.x-b.x,a.y-b.y);
  };
  const before=await markerDistance(),cdp=await connection.context.newCDPSession(page);
  const cx=mapBox.x+mapBox.width/2,cy=mapBox.y+mapBox.height/2;
  const pinchTouches=spread=>[{x:cx-spread,y:cy,id:1},{x:cx+spread,y:cy,id:2}];
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:pinchTouches(35)});
  for(let step=1;step<=15;step++) {
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:pinchTouches(35+step)});
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(markerDistance).toBeGreaterThan(before*1.15);
  report.checks.nativePinchZoom=true;
  await cdp.detach();
  await connection.context.setOffline(false);
  adb('shell','input','keyevent','4');
  await expect(page.getByRole('heading',{name:'City & river crossings'})).toBeVisible();
  report.checks.nativeBack=true;
  report.warnings.push('Real GPS permission/fix, lock screen, physical walking, and actual airplane-mode reopening still require field acceptance.');
  report.passed=true;console.log(JSON.stringify(report,null,2));
} catch(error) {
  report.passed=false;report.error=error instanceof Error?error.message:String(error);
  throw error;
} finally {
  await writeFile(resolve(output,'samsung-phone-smoke.json'),JSON.stringify(report,null,2)+'\n');
  try { await browser?.contexts()[0]?.setOffline(false); } catch { }
  try { adb('forward','--remove','tcp:9223'); } catch { }
  await browser?.close();
}
