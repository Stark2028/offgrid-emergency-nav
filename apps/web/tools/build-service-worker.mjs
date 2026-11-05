import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const assets = (await readdir(resolve(dist, 'assets'))).map((name) => `/assets/${name}`);
const licenses = (await readdir(resolve(dist, 'licenses'))).map((name) => `/licenses/${name}`);
const shell = ['/', '/index.html', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', ...assets, ...licenses];
const hasher = createHash('sha256');
for (const path of shell.slice(1)) hasher.update(path).update(await readFile(resolve(dist, `.${path}`)));
const buildHash = hasher.digest('hex').slice(0, 16);
const source = `
const CACHE = 'offgrid-shell-${buildHash}';
const SHELL = ${JSON.stringify(shell)};
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener('message', (event) => { if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting(); });
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await self.clients.claim();
  const clients = await self.clients.matchAll({ type: 'window' });
  // Old hashed shell files are retained while an older tab may still need them.
  if (clients.length <= 1) {
    for (const key of await caches.keys()) if (key.startsWith('offgrid-shell-') && key !== CACHE) await caches.delete(key);
  }
})()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/packs/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match('/index.html', { ignoreVary: true })).then((cached) => cached || fetch(event.request)));
    return;
  }
  // Only the exact, build-pinned shell paths ignore request-header variation.
  // A server's Vary: Origin must not hide our own cached module/font responses.
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/assets/')) event.respondWith(caches.open(CACHE).then((cache) => cache.match(url.pathname, { ignoreVary: true })).then((cached) => cached || caches.match(url.pathname, { ignoreVary: true })).then((cached) => cached || fetch(event.request)));
});
`;
await writeFile(resolve(dist, 'sw.js'), source);
console.log(`Offline shell ${buildHash}: ${shell.length} assets. Map packs are stored separately in IndexedDB.`);
