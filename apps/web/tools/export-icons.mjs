// Raster exports of the repository's vector mark for PWA install compatibility.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../public/', import.meta.url));
const svg = await readFile(`${directory}icon.svg`, 'utf8');
const browser = await chromium.launch({ channel: process.env.OFFGRID_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<canvas id="icon"></canvas>');
  for (const size of [192, 512]) {
    const image = await page.evaluate(async ({ svg, size }) => {
      const canvas = document.getElementById('icon');
      canvas.width = size; canvas.height = size;
      const source = new Image(); source.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await source.decode();
      canvas.getContext('2d').drawImage(source, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { svg, size });
    await writeFile(`${directory}icon-${size}.png`, Buffer.from(image, 'base64'));
  }
} finally { await browser.close(); }
