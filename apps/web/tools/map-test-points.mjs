import { expect } from '@playwright/test';

// Independent Web Mercator projection for the initial bounds/padding camera.
// Select public graph fixture coordinates through real canvas interactions.
export async function pickMapPoints(page, bounds, points) {
  const root=page.locator('.navigation-map:not(.coverage-map)');
  await expect(root).toHaveAttribute('data-ready','true',{timeout:30000});
  const canvas=root.locator('canvas.maplibregl-canvas');
  const box=await canvas.boundingBox();
  const [w,s,e,n]=bounds;
  const northing=lat=>(1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2;
  const scale=Math.min((box.width-40)/((e-w)/360),(box.height-40)/(northing(s)-northing(n)));
  const cx=(w+e)/720,cy=(northing(s)+northing(n))/2;
  for(const [lon,lat] of points) await canvas.click({position:{x:box.width/2+(lon/360-cx)*scale,y:box.height/2+(northing(lat)-cy)*scale}});
}
