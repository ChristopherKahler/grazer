// A tiny logged-in-looking site on 127.0.0.1 for the live export test.
//
// It plants exactly what a real session plants and what the export has to
// reach: an HttpOnly cookie the page's own JavaScript cannot read, an ordinary
// cookie it can, a localStorage key, and an IndexedDB database whose records
// carry values JSON alone would destroy.

import { createServer } from 'node:http';

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>loading</title></head>
<body>
<h1>grazer fixture</h1>
<script>
(async () => {
  localStorage.setItem('grz_ls', '1');
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('grzdb', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('items')) {
        const store = db.createObjectStore('items', { keyPath: 'id' });
        store.createIndex('by_label', 'label', { unique: false });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      store.put({ id: 1, label: 'plain', note: 'hello' });
      store.put({ id: 2, label: 'dated', at: new Date('2024-05-06T07:08:09.000Z') });
      store.put({ id: 3, label: 'binary', bytes: new Uint8Array([1, 2, 3, 4, 5]) });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  document.title = 'ready';
})().catch((err) => { document.title = 'error: ' + err.message; });
</script>
</body>
</html>
`;

/**
 * Start the fixture. Resolves once it is listening.
 * @returns {Promise<{ port: number, origin: string, close: () => Promise<void> }>}
 */
export function startFixtureSite() {
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    // Server-side proof that a replayed cookie actually travels: only the
    // browser's own cookie jar can put grz_http on this header, since no page
    // script can read or set an HttpOnly cookie.
    if (req.url === '/whoami') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': [
        'grz_http=secret; HttpOnly; Path=/',
        'grz_js=visible; Path=/',
      ],
    });
    res.end(PAGE);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
