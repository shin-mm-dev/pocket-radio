/**
 * Pocket Radio 用 Service Worker（sw.js）
 * 役割：アプリの画面ファイル（HTML/CSS/JS/アイコン）をスマホ内に保存し、
 *       機内モードなどの完全オフライン時でも即座に起動できるようにします。
 */

// キャッシュの名前（ファイルを大きく更新したときは v2, v3... と変えます）
const CACHE_NAME = 'pocket-radio-v7';

// オフラインでも必ず必要なアプリ本体のファイル一覧（すべて相対パスで指定）
// ※存在しないファイルを1つでも含めるとキャッシュ登録が失敗するため、現在あるファイルのみ列挙します
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/storage.js',
  './js/parser.js',
  './js/ui.js',
  './js/player.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

/**
 * インストール時：アプリ本体をまとめてキャッシュに保存する
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/**
 * 有効化時：古いバージョンのキャッシュをお掃除し、すぐ新バージョンに切り替える
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheKeys) =>
        Promise.all(
          cacheKeys
            .filter((key) => key !== CACHE_NAME)
            .map((oldKey) => caches.delete(oldKey))
        )
      )
      .then(() => self.clients.claim())
  );
});

/**
 * 通信発生時（Cache First 戦略）：
 * 1. まず手元のキャッシュにあれば即座に返す（機内モードでも爆速で開く）
 * 2. なければネットワークに取りに行き、成功したらキャッシュにも保存する
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // GET 以外（送信処理など）はそのまま通す
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);

  // blob: や data:、別ドメインへのリクエストは対象外にする
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => {
          // 正常に取得できた同一オリジンのファイルだけキャッシュへ追加保存する
          if (
            networkResponse &&
            networkResponse.ok &&
            networkResponse.type === 'basic'
          ) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // オフラインでページ遷移が失敗したときは、トップページのキャッシュを返す
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 504, statusText: 'Offline' });
        });
    })
  );
});

/**
 * アプリ側からの更新指示メッセージを受け取る
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
