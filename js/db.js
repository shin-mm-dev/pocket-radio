/**
 * Pocket Radio 音声データ保存管理（IndexedDB）
 * 役割：1本10MB〜数十MBある重い音声ファイル本体（Blob）を
 *       ブラウザ内の「大きな倉庫（IndexedDB）」に安全に出し入れします。
 */

const DB_NAME = 'PocketRadioDB';
const DB_VERSION = 1;
const AUDIO_STORE = 'audioFiles';

// 開いたデータベース接続を保持して、毎回開き直さなくて済むようにする
let dbPromise = null;

/**
 * IndexedDB の接続を開く（初回は音声保存用の引き出し「audioFiles」を作成する）
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('このブラウザは IndexedDB に対応していません'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // ファイル名を主キー（重複しない目印）にしてストアを作る
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: 'fileName' });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      // 別タブ等でバージョン変更が起きたら接続を閉じて次回の再接続に備える
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('IndexedDB を開けませんでした'));
    };

    request.onblocked = () => {
      dbPromise = null;
      reject(new Error('データベースの更新が他のタブにブロックされました'));
    };
  });

  return dbPromise;
}

/**
 * 端末の空き容量不足エラー（QuotaExceededError）かどうかを判定する
 * @param {unknown} error
 * @returns {boolean}
 */
export function isQuotaExceededError(error) {
  if (!error) return false;
  const name = error.name || '';
  const message = String(error.message || '').toLowerCase();

  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return true;
  }
  if (name === 'AbortError' && message.includes('quota')) {
    return true;
  }
  // 一部の古いSafari環境で返る数値コード22にも対応
  if (error.code === 22) {
    return true;
  }
  return false;
}

/**
 * 音声ファイル本体を1件保存（または上書き）する
 * @param {{ fileName: string, blob: Blob, size: number, mimeType: string, addedAt: number }} record
 * @returns {Promise<void>}
 */
export async function saveAudioFile(record) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, 'readwrite');
    const store = transaction.objectStore(AUDIO_STORE);
    store.put(record);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error || new Error('音声データの保存に失敗しました'));
    };
    transaction.onabort = () => {
      reject(transaction.error || new Error('音声データの保存が中断されました'));
    };
  });
}

/**
 * 指定したファイル名の音声レコードを1件読み込む
 * @param {string} fileName
 * @returns {Promise<{ fileName: string, blob: Blob, size: number, mimeType: string, addedAt: number } | null>}
 */
export async function getAudioFile(fileName) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, 'readonly');
    const store = transaction.objectStore(AUDIO_STORE);
    const request = store.get(fileName);

    request.onsuccess = () => {
      resolve(request.result || null);
    };
    request.onerror = () => {
      reject(request.error || new Error('音声データの読み込みに失敗しました'));
    };
  });
}

/**
 * 重い音声本体（Blob）を読み込まずに、そのファイル名が保存済みかだけ高速確認する
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
export async function hasAudioFile(fileName) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, 'readonly');
    const store = transaction.objectStore(AUDIO_STORE);
    const request = store.getKey(fileName);

    request.onsuccess = () => {
      resolve(request.result !== undefined);
    };
    request.onerror = () => {
      reject(request.error || new Error('音声データの存在確認に失敗しました'));
    };
  });
}

/**
 * 保存されている全ファイル名の一覧だけを高速取得する（音声本体は読み込まない）
 * @returns {Promise<string[]>}
 */
export async function getAllAudioKeys() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, 'readonly');
    const store = transaction.objectStore(AUDIO_STORE);
    const request = store.getAllKeys();

    request.onsuccess = () => {
      resolve(Array.isArray(request.result) ? request.result.map(String) : []);
    };
    request.onerror = () => {
      reject(request.error || new Error('保存済みファイル一覧の取得に失敗しました'));
    };
  });
}

/**
 * 指定した1件の音声ファイル本体を削除する（容量を解放する）
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export async function deleteAudioFile(fileName) {
  return deleteAudioFiles([fileName]);
}

/**
 * 複数の音声ファイル本体を1回の処理でまとめて削除する
 * @param {string[]} fileNames
 * @returns {Promise<void>}
 */
export async function deleteAudioFiles(fileNames) {
  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    return;
  }

  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, 'readwrite');
    const store = transaction.objectStore(AUDIO_STORE);

    for (const fileName of fileNames) {
      store.delete(fileName);
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error || new Error('音声データの削除に失敗しました'));
    };
    transaction.onabort = () => {
      reject(transaction.error || new Error('音声データの削除が中断されました'));
    };
  });
}

/**
 * ブラウザが把握している使用容量と上限の目安を取得する
 * @returns {Promise<{ usage: number, quota: number } | null>}
 */
export async function getStorageEstimate() {
  try {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      const estimate = await navigator.storage.estimate();
      return {
        usage: typeof estimate.usage === 'number' ? estimate.usage : 0,
        quota: typeof estimate.quota === 'number' ? estimate.quota : 0,
      };
    }
  } catch (error) {
    console.warn('ストレージ容量の目安取得に失敗しました:', error);
  }
  return null;
}
