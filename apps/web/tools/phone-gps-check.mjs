import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';

process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');
const serial=process.env.OFFGRID_ADB_SERIAL;
if(!serial) throw new Error('Select the authorized phone with OFFGRID_ADB_SERIAL.');
const sdk=process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA,'Android/Sdk');
const adb=(...args)=>execFileSync(join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb'),['-s',serial,...args],{encoding:'utf8',timeout:30000});
const pid=adb('shell','pidof','org.offgrid.navigation').trim();
adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9223');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('https://localhost'));
if(!page) throw new Error('OFFGRID is not open.');
const report={model:adb('shell','getprop','ro.product.model').trim(),checkedAt:new Date().toISOString()};
try {
  const open=page.getByRole('button',{name:'Open walking navigation'});
  if(await open.count()) await open.click();
  await page.getByRole('button',{name:'Use my location as start'}).click();
  console.log('Location requested through OFFGRID; awaiting the phone permission/fix.');
  await page.locator('#navigation-location-feedback').waitFor({state:'visible',timeout:90000});
  const message=await page.locator('#navigation-location-feedback').textContent();
  report.result=message.includes('Location accuracy:')?'accurate-fix-within-coverage':message.includes('outside this saved area')?'fix-outside-coverage':message.includes('too approximate')?'fix-too-approximate':/denied|permission/i.test(message)?'permission-denied-or-unavailable':'no-fix-or-services-unavailable';
  // Record categories only. Do not read/store coordinates or capture a GPS pin.
  report.feedbackVisible=true;
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  report.result='not-completed';
  throw error;
} finally {
  await writeFile(resolve(import.meta.dirname,'../../../.impeccable/review/samsung-gps-check.json'),JSON.stringify(report,null,2)+'\n');
  adb('forward','--remove','tcp:9223');
  await browser.close();
}
