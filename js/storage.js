/**
 * Pocket Radio 設定・履歴・再生位置保存（LocalStorage）
 * 役割：軽いテキスト情報（番組名辞書、再生位置、メモ、聴了記録、設定）を
 *       「小さなメモ帳（LocalStorage）」に高速に読み書きし、
 *       画面表示のための絞り込み・並び替え・番組設定管理も行います。
 */

export const META_STORAGE_KEY = 'PocketRadioMeta_v1';
export const PLAYBACK_STORAGE_KEY = 'PocketRadioPlayback_v1';
export const CURRENT_SCHEMA_VERSION = 2;

// 再生速度の切り替えステップ
export const PLAYBACK_RATES = [1.0, 1.25, 1.5, 1.75, 2.0];

// 番組テーマカラー用の視認性が高いプリセット8色
export const PROGRAM_COLOR_PRESETS = [
  '#34d399', // ミントグリーン
  '#38bdf8', // スカイブルー
  '#a78bfa', // ラベンダー
  '#fb7185', // コーラルピンク
  '#fbbf24', // アンバー
  '#a3e635', // ライム
  '#fb923c', // オレンジ
  '#2dd4bf', // ティール
];

/**
 * 実行環境の localStorage を安全に取得する（テスト環境でも動くようにするため）
 */
function getStorage() {
  return globalThis.localStorage;
}

/**
 * 初期状態のデータ構造を作成する
 */
export function createDefaultMeta() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    episodes: {},
    programs: {
      Harusanchi: {
        key: 'Harusanchi',
        name: '井上春華のはるさんち',
        color: '#34d399',
        order: 1,
      },
      'Dominant-Life': {
        key: 'Dominant-Life',
        name: '佐藤優樹のDominant Life!',
        color: '#2dd4bf',
        order: 2,
      },
      _other: {
        key: '_other',
        name: 'その他',
        color: '#94a3b8',
        order: 999,
      },
    },
    memos: [],
    completedHistory: [],
    settings: {
      autoPlayNext: true,
      playbackRate: 1.0,
      sortOrder: 'desc',
      activeProgramTab: 'all',
      activeFilter: 'playable',
      completedThreshold: 0.95,
    },
  };
}

/**
 * 読み込んだデータに不足している項目があれば、初期値で安全に補う
 * applyMigrations=true のときは、古いバージョン(v1)からの自動移行も1回だけ行う
 * @param {any} raw
 * @param {{ applyMigrations?: boolean }} options
 */
function normalizeMeta(raw, { applyMigrations = false } = {}) {
  const defaults = createDefaultMeta();
  if (!raw || typeof raw !== 'object') {
    return defaults;
  }

  const rawVersion = Number(raw.schemaVersion) || 1;
  const programs =
    raw.programs && typeof raw.programs === 'object'
      ? { ...raw.programs }
      : { ...defaults.programs };

  const episodes =
    raw.episodes && typeof raw.episodes === 'object' ? { ...raw.episodes } : {};

  // v1 -> v2 自動移行：すでにアプリを起動済みの環境へ「佐藤優樹のDominant Life!」を1回だけ追加する
  if (applyMigrations && rawVersion < 2) {
    const hasDominantLife = Object.keys(programs).some(
      (k) => k.toLowerCase() === 'dominant-life'
    );
    if (!hasDominantLife) {
      programs['Dominant-Life'] = { ...defaults.programs['Dominant-Life'] };
    }

    for (const ep of Object.values(episodes)) {
      if (ep && typeof ep.programKey === 'string' && ep.programKey.toLowerCase() === 'dominant-life') {
        ep.programKey = 'Dominant-Life';
      }
    }
  }

  // 「その他」グループは削除されても必ず存在するように保証する
  if (!programs._other) {
    programs._other = { ...defaults.programs._other };
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    episodes,
    programs,
    memos: Array.isArray(raw.memos) ? raw.memos : [],
    completedHistory: Array.isArray(raw.completedHistory) ? raw.completedHistory : [],
    settings: {
      ...defaults.settings,
      ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}),
    },
  };
}

/**
 * LocalStorage からメタ情報を読み込む（初回や破損時は初期値を作成）
 */
export function loadMeta() {
  try {
    const json = getStorage()?.getItem(META_STORAGE_KEY);
    if (!json) {
      return createDefaultMeta();
    }
    const parsed = JSON.parse(json);
    const rawVersion = Number(parsed?.schemaVersion) || 1;
    const normalized = normalizeMeta(parsed, { applyMigrations: true });

    // 古いバージョンからの移行が行われた場合は、結果を保存して次回以降勝手に再追加されないようにする
    if (rawVersion < CURRENT_SCHEMA_VERSION) {
      saveMeta(normalized);
    }
    return normalized;
  } catch (error) {
    console.warn('メタデータの読み込みに失敗したため初期値を使用します:', error);
    return createDefaultMeta();
  }
}

/**
 * メタ情報を LocalStorage へ保存する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @returns {boolean} 成功したかどうか
 */
export function saveMeta(meta) {
  try {
    getStorage()?.setItem(META_STORAGE_KEY, JSON.stringify(meta));
    return true;
  } catch (error) {
    console.error('メタデータの保存に失敗しました:', error);
    return false;
  }
}

/**
 * アプリ設定の一部を更新して保存する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {Partial<ReturnType<typeof createDefaultMeta>['settings']>} partialSettings
 */
export function updateSettings(meta, partialSettings) {
  meta.settings = {
    ...meta.settings,
    ...partialSettings,
  };
  return saveMeta(meta);
}

/**
 * 再生中3秒ごとに保存される「いまの再生位置」だけを読み込む
 * @returns {{ currentFileName: string, currentTime: number, updatedAt: number } | null}
 */
export function loadPlayback() {
  try {
    const json = getStorage()?.getItem(PLAYBACK_STORAGE_KEY);
    if (!json) return null;
    const data = JSON.parse(json);
    if (!data || typeof data.currentFileName !== 'string') return null;
    return {
      currentFileName: data.currentFileName,
      currentTime: typeof data.currentTime === 'number' && Number.isFinite(data.currentTime) ? data.currentTime : 0,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * いま再生中のファイル名と再生秒数を軽量キーへ即時保存する
 * @param {string} currentFileName
 * @param {number} currentTime
 */
export function savePlayback(currentFileName, currentTime) {
  if (!currentFileName) return false;
  try {
    const payload = {
      currentFileName,
      currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? Math.round(currentTime * 100) / 100 : 0,
      updatedAt: Date.now(),
    };
    getStorage()?.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (error) {
    console.error('再生位置の保存に失敗しました:', error);
    return false;
  }
}

/**
 * 一時保存されている再生位置データを消去する
 */
export function clearPlayback() {
  try {
    getStorage()?.removeItem(PLAYBACK_STORAGE_KEY);
  } catch {
    // 失敗しても処理続行
  }
}

/**
 * 起動時に「直前の再生位置（PocketRadioPlayback_v1）」の方が新しければ、
 * エピソード一覧側の再生位置（currentTime）へ安全に反映する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @returns {boolean} 更新があったかどうか
 */
export function mergePlaybackIntoMeta(meta) {
  const playback = loadPlayback();
  if (!playback) return false;

  const episode = meta.episodes[playback.currentFileName];
  if (!episode) return false;

  const episodeUpdatedAt = episode.lastPlayedAt || 0;
  if (playback.updatedAt >= episodeUpdatedAt && playback.currentTime > 0) {
    episode.currentTime = playback.currentTime;
    episode.lastPlayedAt = playback.updatedAt;
    if (episode.status === 'unplayed') {
      episode.status = 'playing';
    }
    saveMeta(meta);
    return true;
  }
  return false;
}

/**
 * エピソード1件を追加または更新して保存する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {object} episode
 */
export function upsertEpisode(meta, episode) {
  meta.episodes[episode.fileName] = episode;
  return saveMeta(meta);
}

/**
 * 現在アプリ内に保存されている音声ファイルの本数と合計サイズを計算する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 */
export function getTotalAudioStats(meta) {
  const allEpisodes = Object.values(meta.episodes || {});
  let playableCount = 0;
  let totalBytes = 0;

  for (const ep of allEpisodes) {
    if (ep && ep.hasAudio) {
      playableCount += 1;
      totalBytes += Number(ep.fileSize) || 0;
    }
  }

  return {
    playableCount,
    totalCount: allEpisodes.length,
    totalBytes,
  };
}

/**
 * 番組キーから画面表示用の番組名・テーマカラーを返す
 * 未登録の番組キーが来た場合は、そのままのキー名＋青色系を仮割り当てして返す
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} programKey
 */
export function getProgramDisplayInfo(meta, programKey) {
  const programs = meta.programs || {};
  if (programs[programKey]) {
    return {
      key: programKey,
      name: programs[programKey].name || programKey,
      color: programs[programKey].color || '#34d399',
      isUnmapped: false,
    };
  }

  return {
    key: programKey || '_other',
    name: programKey || 'その他',
    color: '#60a5fa',
    isUnmapped: programKey !== '_other',
  };
}

/**
 * 取り込み済みエピソードのうち、まだ番組マッピングが未設定の番組キー一覧を返す
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @returns {string[]}
 */
export function getUnmappedProgramKeys(meta) {
  const keys = new Set();
  const programs = meta.programs || {};

  for (const ep of Object.values(meta.episodes || {})) {
    if (!ep || !ep.programKey || ep.programKey === '_other') continue;
    if (!programs[ep.programKey]) {
      keys.add(ep.programKey);
    }
  }

  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

/**
 * 番組マッピング（番組キー ⇔ 日本語名・テーマカラー）を追加または更新する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {{ originalKey?: string | null, key: string, name: string, color: string }} input
 */
export function saveProgramMapping(meta, { originalKey = null, key, name, color }) {
  const isEditingOther = originalKey === '_other';
  const trimmedKey = isEditingOther ? '_other' : String(key || '').trim();
  const trimmedName = String(name || '').trim();
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(String(color || '').trim())
    ? String(color).trim()
    : '#34d399';

  if (!trimmedKey) {
    return { ok: false, error: '番組キー（ファイル名の先頭文字）を入力してください' };
  }
  if (!trimmedName) {
    return { ok: false, error: '表示名を入力してください' };
  }
  if (!isEditingOther && trimmedKey === '_other') {
    return { ok: false, error: '「_other」はシステム予約名のため使用できません' };
  }
  if (!isEditingOther && trimmedKey.toLowerCase() === 'all') {
    return { ok: false, error: '「all」は予約名のため使用できません' };
  }

  // 登録済み他キーとの大文字小文字重複チェック
  const lowerNewKey = trimmedKey.toLowerCase();
  for (const existingKey of Object.keys(meta.programs || {})) {
    if (existingKey === originalKey) continue;
    if (existingKey.toLowerCase() === lowerNewKey) {
      return { ok: false, error: `番組キー「${existingKey}」がすでに登録されています` };
    }
  }

  // 次の並び順を決める
  let order = 1;
  if (originalKey && meta.programs[originalKey]) {
    order = meta.programs[originalKey].order ?? 1;
  } else {
    const existingOrders = Object.values(meta.programs || {})
      .filter((p) => p && p.key !== '_other')
      .map((p) => Number(p.order) || 0);
    order = existingOrders.length > 0 ? Math.max(...existingOrders) + 1 : 1;
  }

  // キー名が変わった場合や、大文字小文字違いで散らばっていたエピソードのキーを統一する
  for (const ep of Object.values(meta.episodes || {})) {
    if (!ep || !ep.programKey) continue;
    const matchOriginal = originalKey && ep.programKey === originalKey;
    const matchCaseInsensitive = !isEditingOther && ep.programKey.toLowerCase() === lowerNewKey;
    if (matchOriginal || matchCaseInsensitive) {
      ep.programKey = trimmedKey;
    }
  }

  if (originalKey && originalKey !== trimmedKey) {
    delete meta.programs[originalKey];
    if (meta.settings?.activeProgramTab === originalKey) {
      meta.settings.activeProgramTab = trimmedKey;
    }
  }

  const program = {
    key: trimmedKey,
    name: trimmedName,
    color: safeColor,
    order: trimmedKey === '_other' ? 999 : order,
  };
  meta.programs[trimmedKey] = program;
  saveMeta(meta);

  return { ok: true, program };
}

/**
 * 番組マッピングを削除する（エピソード本体は削除せず未設定キーに戻す）
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} key
 */
export function deleteProgramMapping(meta, key) {
  if (!key || key === '_other' || !meta.programs?.[key]) {
    return { ok: false, error: 'この番組は削除できません' };
  }
  delete meta.programs[key];
  saveMeta(meta);
  return { ok: true };
}

/**
 * エピソードの重い音声本体だけを削除した状態にする（メタ・メモ・聴了記録は残す）
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} fileName
 */
export function markEpisodeAudioDeleted(meta, fileName) {
  const ep = meta.episodes?.[fileName];
  if (!ep) return false;
  ep.hasAudio = false;
  return saveMeta(meta);
}

/**
 * 聴了記録を取り消す（音声削除済みの回をもう一度iCloudから再取り込みできるようにする）
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} fileName
 */
export function revokeEpisodeCompleted(meta, fileName) {
  if (!fileName) return false;

  meta.completedHistory = (meta.completedHistory || []).filter((name) => name !== fileName);

  const ep = meta.episodes?.[fileName];
  if (ep) {
    ep.status = ep.currentTime > 0 ? 'playing' : 'unplayed';
    ep.completedAt = null;
  }

  return saveMeta(meta);
}

/**
 * 番組タブバー表示用のデータ一覧を組み立てる
 * 並び順：すべて -> 登録済み番組 -> 未設定の番組キー -> その他（1件以上ある時のみ）
 * @param {ReturnType<typeof createDefaultMeta>} meta
 */
export function buildProgramTabs(meta) {
  const allEpisodes = Object.values(meta.episodes || {});
  const statsByKey = new Map();

  let totalPlayable = 0;
  let totalBytes = 0;

  for (const ep of allEpisodes) {
    if (!ep) continue;
    const key = ep.programKey || '_other';
    if (!statsByKey.has(key)) {
      statsByKey.set(key, { count: 0, playableCount: 0, totalBytes: 0 });
    }
    const bucket = statsByKey.get(key);
    bucket.count += 1;
    if (ep.hasAudio) {
      bucket.playableCount += 1;
      bucket.totalBytes += Number(ep.fileSize) || 0;
      totalPlayable += 1;
      totalBytes += Number(ep.fileSize) || 0;
    }
  }

  const tabs = [
    {
      key: 'all',
      name: 'すべて',
      color: '#34d399',
      count: allEpisodes.length,
      playableCount: totalPlayable,
      totalBytes,
      isUnmapped: false,
    },
  ];

  // 登録済み番組（_other除く）を order 順で追加
  const registeredPrograms = Object.values(meta.programs || {})
    .filter((p) => p && p.key !== '_other')
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name, 'ja'));

  for (const prog of registeredPrograms) {
    const st = statsByKey.get(prog.key) || { count: 0, playableCount: 0, totalBytes: 0 };
    tabs.push({
      key: prog.key,
      name: prog.name,
      color: prog.color || '#34d399',
      count: st.count,
      playableCount: st.playableCount,
      totalBytes: st.totalBytes,
      isUnmapped: false,
    });
  }

  // 未設定キーを追加
  const unmappedKeys = getUnmappedProgramKeys(meta);
  for (const key of unmappedKeys) {
    const st = statsByKey.get(key) || { count: 0, playableCount: 0, totalBytes: 0 };
    tabs.push({
      key,
      name: key,
      color: '#60a5fa',
      count: st.count,
      playableCount: st.playableCount,
      totalBytes: st.totalBytes,
      isUnmapped: true,
    });
  }

  // その他（_other）は1件以上あるときだけ表示
  const otherStats = statsByKey.get('_other');
  if (otherStats && otherStats.count > 0) {
    const otherInfo = meta.programs?._other || { name: 'その他', color: '#94a3b8' };
    tabs.push({
      key: '_other',
      name: otherInfo.name || 'その他',
      color: otherInfo.color || '#94a3b8',
      count: otherStats.count,
      playableCount: otherStats.playableCount,
      totalBytes: otherStats.totalBytes,
      isUnmapped: false,
    });
  }

  return tabs;
}

/**
 * 選択中の番組タブ・再生状態フィルター・並び順に従ってエピソード配列を返す
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {{ programTab?: string, filter?: 'playable'|'all'|'completed', sortOrder?: 'desc'|'asc' }} options
 */
export function filterAndSortEpisodes(meta, options = {}) {
  const programTab = options.programTab || meta.settings?.activeProgramTab || 'all';
  const filter = options.filter || meta.settings?.activeFilter || 'playable';
  const sortOrder = options.sortOrder || meta.settings?.sortOrder || 'desc';

  const list = Object.values(meta.episodes || []).filter((ep) => {
    if (!ep) return false;

    if (programTab !== 'all' && ep.programKey !== programTab) {
      return false;
    }

    if (filter === 'playable') {
      return ep.hasAudio === true && ep.status !== 'completed';
    }
    if (filter === 'completed') {
      return ep.status === 'completed';
    }
    return true;
  });

  list.sort((a, b) => {
    const dateA = a.broadcastDate || '';
    const dateB = b.broadcastDate || '';
    if (dateA !== dateB) {
      return sortOrder === 'desc' ? dateB.localeCompare(dateA) : dateA.localeCompare(dateB);
    }
    return sortOrder === 'desc'
      ? b.fileName.localeCompare(a.fileName)
      : a.fileName.localeCompare(b.fileName);
  });

  return list;
}

/**
 * 現在の再生速度から次の再生速度を循環して返す（1.0 -> 1.25 -> 1.5 -> 1.75 -> 2.0 -> 1.0）
 * @param {number} currentRate
 * @returns {number}
 */
export function getNextPlaybackRate(currentRate) {
  const index = PLAYBACK_RATES.findIndex((rate) => Math.abs(rate - currentRate) < 0.01);
  if (index === -1) {
    return PLAYBACK_RATES[0];
  }
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
}

/**
 * 指定したエピソードを「聴了済み」に更新し、聴了履歴にも追加する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} fileName
 * @returns {boolean} 新たに聴了状態へ変わった場合は true
 */
export function markEpisodeCompleted(meta, fileName) {
  const ep = meta.episodes?.[fileName];
  if (!ep) return false;

  if (!Array.isArray(meta.completedHistory)) {
    meta.completedHistory = [];
  }

  const alreadyCompleted =
    ep.status === 'completed' && meta.completedHistory.includes(fileName);
  if (alreadyCompleted) {
    return false;
  }

  ep.status = 'completed';
  if (!ep.completedAt) {
    ep.completedAt = Date.now();
  }
  if (!meta.completedHistory.includes(fileName)) {
    meta.completedHistory.push(fileName);
  }

  saveMeta(meta);
  return true;
}

/**
 * 再生位置（currentTime）や総時間（duration）をエピソード情報に反映する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} fileName
 * @param {{ currentTime?: number, duration?: number, persist?: boolean }} update
 * @returns {boolean}
 */
export function updateEpisodeProgress(
  meta,
  fileName,
  { currentTime, duration, persist = true } = {}
) {
  const ep = meta.episodes?.[fileName];
  if (!ep) return false;

  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    ep.duration = Math.round(duration * 100) / 100;
  }

  if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0) {
    ep.currentTime = Math.round(currentTime * 100) / 100;
    ep.lastPlayedAt = Date.now();
  }

  if (ep.status === 'unplayed' && ep.currentTime > 0) {
    ep.status = 'playing';
  }

  if (persist) {
    saveMeta(meta);
  }
  return true;
}

/**
 * 連続再生用：現在の表示条件（番組タブ・並び順）で次に再生できる未聴／途中エピソードを探す
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} currentFileName
 * @param {{ programTab?: string, sortOrder?: 'desc'|'asc' }} options
 */
export function findNextPlayableEpisode(meta, currentFileName, options = {}) {
  const programTab = options.programTab || meta.settings?.activeProgramTab || 'all';
  const sortOrder = options.sortOrder || meta.settings?.sortOrder || 'desc';

  const orderedList = filterAndSortEpisodes(meta, {
    programTab,
    filter: 'all',
    sortOrder,
  });

  const currentIndex = orderedList.findIndex((ep) => ep.fileName === currentFileName);
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;

  for (let i = startIndex; i < orderedList.length; i += 1) {
    const candidate = orderedList[i];
    if (
      candidate &&
      candidate.fileName !== currentFileName &&
      candidate.hasAudio === true &&
      candidate.status !== 'completed'
    ) {
      return candidate;
    }
  }

  return null;
}

/**
 * アプリ起動時にミニプレイヤーへスタンバイ表示する「前回の続き候補」を探す
 * @param {ReturnType<typeof createDefaultMeta>} meta
 */
export function findResumeCandidateEpisode(meta) {
  const episodes = meta.episodes || {};
  const playback = loadPlayback();

  if (playback?.currentFileName) {
    const savedEp = episodes[playback.currentFileName];
    if (savedEp && savedEp.hasAudio === true) {
      return savedEp;
    }
  }

  let latestEp = null;
  let latestTime = 0;

  for (const ep of Object.values(episodes)) {
    if (!ep || ep.hasAudio !== true || !ep.lastPlayedAt) continue;
    if (ep.lastPlayedAt > latestTime) {
      latestTime = ep.lastPlayedAt;
      latestEp = ep;
    }
  }

  return latestEp;
}

/**
 * タイムスタンプ付きメモを1件追加して保存する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {{ fileName: string, timestampSec: number, text: string }} input
 */
export function addMemo(meta, { fileName, timestampSec, text }) {
  const trimmedText = String(text || '').trim();
  if (!trimmedText) {
    return { ok: false, error: 'メモ内容を入力してください' };
  }
  if (!fileName) {
    return { ok: false, error: '対象のエピソードが選択されていません' };
  }

  if (!Array.isArray(meta.memos)) {
    meta.memos = [];
  }

  const safeSec = Math.max(0, Math.floor(Number(timestampSec) || 0));
  const memo = {
    id: `memo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    fileName,
    timestampSec: safeSec,
    text: trimmedText,
    createdAt: Date.now(),
  };

  meta.memos.push(memo);
  saveMeta(meta);
  return { ok: true, memo };
}

/**
 * 既存のメモを更新して保存する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} memoId
 * @param {{ text: string, timestampSec?: number }} update
 */
export function updateMemo(meta, memoId, { text, timestampSec }) {
  const trimmedText = String(text || '').trim();
  if (!trimmedText) {
    return { ok: false, error: 'メモ内容を入力してください' };
  }

  const memo = (meta.memos || []).find((m) => m && m.id === memoId);
  if (!memo) {
    return { ok: false, error: 'メモが見つかりませんでした' };
  }

  memo.text = trimmedText;
  if (typeof timestampSec === 'number' && Number.isFinite(timestampSec)) {
    memo.timestampSec = Math.max(0, Math.floor(timestampSec));
  }

  saveMeta(meta);
  return { ok: true, memo };
}

/**
 * 指定したIDのメモを削除する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} memoId
 * @returns {boolean} 削除できたら true
 */
export function deleteMemo(meta, memoId) {
  const beforeLength = (meta.memos || []).length;
  meta.memos = (meta.memos || []).filter((m) => m && m.id !== memoId);
  if (meta.memos.length === beforeLength) {
    return false;
  }
  saveMeta(meta);
  return true;
}

/**
 * 特定エピソードに紐づくメモをタイムスタンプ（秒数）が早い順に返す
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string} fileName
 */
export function getEpisodeMemos(meta, fileName) {
  if (!fileName) return [];
  return (meta.memos || [])
    .filter((m) => m && m.fileName === fileName)
    .sort((a, b) => a.timestampSec - b.timestampSec || a.createdAt - b.createdAt);
}

/**
 * 全エピソードを横断してメモを検索・番組絞り込みし、新しい順で返す
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {{ search?: string, programKey?: string }} options
 */
export function queryAllMemos(meta, { search = '', programKey = 'all' } = {}) {
  const keyword = String(search || '').trim().toLowerCase();
  const episodes = meta.episodes || {};

  const items = [];
  for (const memo of meta.memos || []) {
    if (!memo) continue;
    const episode = episodes[memo.fileName] || null;
    const resolvedProgramKey = episode?.programKey || '_other';
    const program = getProgramDisplayInfo(meta, resolvedProgramKey);

    if (programKey !== 'all' && program.key !== programKey) {
      continue;
    }

    if (keyword) {
      const haystack = [
        memo.text,
        episode?.title || '',
        memo.fileName,
        program.name,
      ]
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(keyword)) {
        continue;
      }
    }

    items.push({ memo, episode, program });
  }

  items.sort((a, b) => (b.memo.createdAt || 0) - (a.memo.createdAt || 0));
  return items;
}

/**
 * 音声本体が端末に残っていて、かつ聴了済みのエピソード一覧を返す（一括削除の対象）
 * @param {ReturnType<typeof createDefaultMeta>} meta
 */
export function getDeletableCompletedEpisodes(meta) {
  return Object.values(meta.episodes || {}).filter(
    (ep) => ep && ep.hasAudio === true && ep.status === 'completed'
  );
}

/**
 * 複数エピソードの音声削除状態をまとめて更新する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {string[]} fileNames
 * @returns {number} 更新した件数
 */
export function markEpisodesAudioDeleted(meta, fileNames) {
  let updated = 0;
  for (const fileName of fileNames || []) {
    const ep = meta.episodes?.[fileName];
    if (ep && ep.hasAudio) {
      ep.hasAudio = false;
      updated += 1;
    }
  }
  if (updated > 0) {
    saveMeta(meta);
  }
  return updated;
}

/**
 * 番組設定・エピソード進捗・メモ・聴了履歴をバックアップ用のJSONオブジェクトにまとめる
 * （重い音声本体ファイルは含めません）
 * @param {ReturnType<typeof createDefaultMeta>} meta
 */
export function createBackupPayload(meta) {
  return {
    app: 'Pocket Radio',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      programs: meta.programs || {},
      episodes: meta.episodes || {},
      memos: meta.memos || [],
      completedHistory: meta.completedHistory || [],
      settings: meta.settings || {},
    },
  };
}

/**
 * バックアップJSON文字列を読み取り、Pocket Radioの正しいデータか検証する
 * @param {string} jsonText
 */
export function parseAndValidateBackup(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText || ''));
  } catch {
    return { ok: false, error: 'JSONファイルの形式が正しくありません' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Pocket Radio のバックアップファイルではありません' };
  }

  let rawData = null;
  if (parsed.app === 'Pocket Radio' && parsed.data && typeof parsed.data === 'object') {
    rawData = parsed.data;
  } else if (
    Number(parsed.schemaVersion) >= 1 &&
    parsed.episodes &&
    typeof parsed.episodes === 'object'
  ) {
    // もし生メタデータ形式が直接渡された場合も受け入れられるようにする
    rawData = parsed;
  } else {
    return { ok: false, error: 'Pocket Radio のバックアップファイルではありません' };
  }

  const normalized = normalizeMeta(rawData, { applyMigrations: false });
  const summary = {
    programCount: Object.keys(normalized.programs).filter((k) => k !== '_other').length,
    episodeCount: Object.keys(normalized.episodes).length,
    memoCount: normalized.memos.length,
    historyCount: normalized.completedHistory.length,
  };

  return {
    ok: true,
    data: normalized,
    summary,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null,
  };
}

/**
 * 検証済みのバックアップデータを現在のアプリ状態へ反映する
 * @param {ReturnType<typeof createDefaultMeta>} meta
 * @param {ReturnType<typeof createDefaultMeta>} backupData
 * @param {'merge' | 'replace'} mode
 */
export function applyBackupData(meta, backupData, mode = 'merge') {
  const safeBackup = normalizeMeta(backupData, { applyMigrations: false });

  if (mode === 'replace') {
    const replacedEpisodes = {};
    for (const [fileName, ep] of Object.entries(safeBackup.episodes)) {
      if (!ep || !ep.fileName) continue;
      // 音声本体はこの端末のIndexedDB再照合で確定するため一旦falseにする
      replacedEpisodes[fileName] = {
        ...ep,
        hasAudio: false,
      };
    }

    meta.schemaVersion = CURRENT_SCHEMA_VERSION;
    meta.programs = safeBackup.programs;
    meta.episodes = replacedEpisodes;
    meta.memos = safeBackup.memos;
    meta.completedHistory = Array.from(new Set(safeBackup.completedHistory));
    meta.settings = safeBackup.settings;
    saveMeta(meta);
    return meta;
  }

  // merge（現在のデータと統合）モード
  meta.programs = {
    ...(meta.programs || {}),
    ...safeBackup.programs,
  };
  if (!meta.programs._other) {
    meta.programs._other = createDefaultMeta().programs._other;
  }

  for (const [fileName, incomingEp] of Object.entries(safeBackup.episodes)) {
    if (!incomingEp || !incomingEp.fileName) continue;
    const currentEp = meta.episodes[fileName];

    if (!currentEp) {
      meta.episodes[fileName] = {
        ...incomingEp,
        hasAudio: false,
      };
      continue;
    }

    // 同じ曲が両方に存在する場合は、端末内の音声有無を維持しつつ進捗・聴了を賢くマージする
    const incomingPlayedAt = Number(incomingEp.lastPlayedAt) || 0;
    const currentPlayedAt = Number(currentEp.lastPlayedAt) || 0;
    const useIncomingProgress = incomingPlayedAt > currentPlayedAt;

    const isCompleted =
      currentEp.status === 'completed' || incomingEp.status === 'completed';

    let mergedStatus = useIncomingProgress ? incomingEp.status : currentEp.status;
    if (isCompleted) {
      mergedStatus = 'completed';
    }

    meta.episodes[fileName] = {
      ...currentEp,
      programKey: currentEp.programKey || incomingEp.programKey,
      duration: currentEp.duration ?? incomingEp.duration ?? null,
      currentTime: useIncomingProgress ? incomingEp.currentTime : currentEp.currentTime,
      lastPlayedAt: Math.max(currentPlayedAt, incomingPlayedAt) || null,
      completedAt:
        isCompleted
          ? currentEp.completedAt || incomingEp.completedAt || Date.now()
          : null,
      status: mergedStatus,
      // 端末上の音声ファイル実体情報は現在のものを維持する
      hasAudio: Boolean(currentEp.hasAudio),
      fileSize: currentEp.fileSize || incomingEp.fileSize || 0,
    };
  }

  // メモはIDまたは内容キーで重複を除外して統合する
  const existingMemoIds = new Set((meta.memos || []).map((m) => m.id));
  const existingMemoKeys = new Set(
    (meta.memos || []).map((m) => `${m.fileName}|${m.timestampSec}|${m.text}`)
  );

  for (const memo of safeBackup.memos) {
    if (!memo || !memo.fileName || !memo.text) continue;
    const contentKey = `${memo.fileName}|${memo.timestampSec}|${memo.text}`;
    if (existingMemoIds.has(memo.id) || existingMemoKeys.has(contentKey)) {
      continue;
    }
    meta.memos.push(memo);
    existingMemoIds.add(memo.id);
    existingMemoKeys.add(contentKey);
  }

  // 聴了履歴の統合
  meta.completedHistory = Array.from(
    new Set([...(meta.completedHistory || []), ...(safeBackup.completedHistory || [])])
  );

  // 再生設定はバックアップ側の連続再生・速度を取り入れつつ、画面タブ選択は今の状態を保つ
  meta.settings = {
    ...meta.settings,
    autoPlayNext: safeBackup.settings?.autoPlayNext ?? meta.settings.autoPlayNext,
    playbackRate: safeBackup.settings?.playbackRate ?? meta.settings.playbackRate,
  };

  saveMeta(meta);
  return meta;
}
