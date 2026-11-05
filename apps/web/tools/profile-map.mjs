// Only OFFGRID: no GPS reads, captures, settings changes, or data clearing.
import { chromium, expect } from '@playwright/test';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');
const serial=process.env.OFFGRID_ADB_SERIAL;
if(!serial) throw new Error('Set OFFGRID_ADB_SERIAL to the authorized test phone.');
const sdk=process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA,'Android/Sdk');
const executable=join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb');
const adb=(...args)=>execFileSync(executable,['-s',serial,...args],{encoding:'utf8',timeout:30000});
const run=promisify(execFile),app='org.offgrid.navigation';
let browser;
try {
  for(let attempt=0;attempt<20;attempt++) {
    try {
      const pid=adb('shell','pidof',app).trim();
      adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`);
      browser=await chromium.connectOverCDP('http://127.0.0.1:9223',{timeout:1500});break;
    } catch { await new Promise(resolve=>setTimeout(resolve,500)); }
  }
  if(!browser) throw new Error('OFFGRID debug WebView did not become available.');
  const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('https://localhost'));
  if(!page) throw new Error('Open OFFGRID first.');
  await page.waitForFunction(()=>document.querySelector('.navigation-shell') || [...document.querySelectorAll('button')].some(button=>button.textContent==='Open walking navigation'),{},{timeout:60000});
  const open=page.getByRole('button',{name:'Open walking navigation'});
  if(await open.count()) await open.click();
  await expect(page.getByRole('heading',{name:'Where are you heading?'})).toBeVisible({timeout:30000});
  const renderer=await page.locator('.navigation-map').getAttribute('data-renderer');
  if(renderer==='webgl') await expect(page.locator('.navigation-map')).toHaveAttribute('data-ready','true',{timeout:30000});
  const samples=[];
  for(let trial=0;trial<3;trial++) {
    await page.getByRole('button',{name:'Show whole area',exact:true}).click();
    // Keep the same scale as five old SVG 1.5x zoom steps: 1.5^5.
    // New map zoom buttons use a standard doubling step.
    const steps=await page.locator('.navigation-map').getAttribute('data-renderer')==='webgl'?3:5;
    for(let i=0;i<steps;i++) { await page.getByRole('button',{name:'Zoom in',exact:true}).click();await page.waitForTimeout(200); }
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.waitForTimeout(500);
    const rect=await page.locator('.navigation-map').boundingBox();
    const ratio=await page.evaluate(()=>devicePixelRatio);
    const a=Math.round((rect.x+rect.width*.25)*ratio),b=Math.round((rect.x+rect.width*.75)*ratio),y=Math.round((rect.y+rect.height*.6)*ratio);
    await page.evaluate(()=>{
      const state={frames:[],longTasks:[],mutations:0,last:performance.now(),running:true};
      const loop=time=>{if(!state.running)return;state.frames.push(time-state.last);state.last=time;requestAnimationFrame(loop);};
      state.observer=new PerformanceObserver(list=>state.longTasks.push(...list.getEntries().map(e=>e.duration)));
      state.observer.observe({type:'longtask',buffered:false});
      state.dom=new MutationObserver(entries=>state.mutations+=entries.length);
      state.dom.observe(document.querySelector('.navigation-map'),{attributes:true,subtree:true});
      window.__offgridProfile=state;requestAnimationFrame(loop);
    });
    for(let i=0;i<4;i++) {
      const focus=adb('shell','dumpsys','window').split('\n').find(line=>line.includes('mCurrentFocus='));
      if(!focus?.includes(app)) throw new Error('OFFGRID left foreground; refusing touch input to another app.');
      await run(executable,['-s',serial,'shell','input','swipe',String(i%2?b:a),String(y),String(i%2?a:b),String(y),'600'],{timeout:10000});
    }
    const result=await page.evaluate(()=>{
      const state=window.__offgridProfile;state.running=false;state.observer.disconnect();state.dom.disconnect();delete window.__offgridProfile;
      const frames=state.frames.slice(1).sort((a,b)=>a-b),percentile=p=>frames[Math.floor((frames.length-1)*p)];
      return {frameCount:frames.length,medianFrameMs:percentile(.5),p95FrameMs:percentile(.95),maxFrameMs:Math.max(...frames),framesOver25ms:frames.filter(n=>n>25).length,longTasks:state.longTasks,mapDomMutations:state.mutations};
    });
    samples.push(result);
  }
  const report={model:adb('shell','getprop','ro.product.model').trim(),renderer:await page.locator('.navigation-map').getAttribute('data-renderer') ?? 'svg',recordedAt:new Date().toISOString(),method:'Three runs of four 600ms Android touch swipes; SVG at 1.5^5 zoom, WebGL at 2^3 (5.3% closer); rAF intervals include ADB command gaps; debug WebView',samples};
  const output=resolve(import.meta.dirname,'../../../.impeccable/review');await mkdir(output,{recursive:true});
  await writeFile(join(output,`samsung-map-profile-${process.env.OFFGRID_PROFILE_NAME ?? 'current'}.json`),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally { adb('forward','--remove','tcp:9223');await browser?.close(); }
