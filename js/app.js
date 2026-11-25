/**
 * Pocket Radio メイン起動スクリプト（Phase 6：完成版・全機能統合）
 * 役割：
 *  1. Service Worker の登録と PWA 案内バナーの表示制御
 *  2. IndexedDB（音声本体）と LocalStorage（メタ情報）の読み込み＆自動整合性チェック
 *  3. iCloud Drive 等からの複数ファイル直列取り込み（重複スキップ・進捗表示・解析）
 *  4. 音声プレイヤー・スリープタイマー・タイムスタンプメモ・一括容量解放・JSONバックアップの統合制御
 */

import {
  deleteAudioFile,
  deleteAudioFiles,
  getAllAudioKeys,
  getAudioFile,
  getStorageEstimate,
  isQuotaExceededError,
  saveAudioFile,
} from './db.js';
import {
  detectAudioFormat,
  extractAudioDuration,
  formatDuration,
  formatFileSize,
  parseFileName,
} from './parser.js';
import { createAudioPlayer } from './player.js';
import {
  addMemo,
  applyBackupData,
  buildProgramTabs,
  createBackupPayload,
  deleteMemo,
  deleteProgramMapping,
  filterAndSortEpisodes,
  findResumeCandidateEpisode,
  getDeletableCompletedEpisodes,
  getEpisodeMemos,
  loadMeta,
  markEpisodeAudioDeleted,
  markEpisodeCompleted,
  markEpisodesAudioDeleted,
  mergePlaybackIntoMeta,
  parseAndValidateBackup,
  PROGRAM_COLOR_PRESETS,
  revokeEpisodeCompleted,
  saveMeta,
  saveProgramMapping,
  updateMemo,
  updateSettings,
  upsertEpisode,
} from './storage.js';
import {
  chooseBackupImportMode,
  closeFullPlayer,
  closeModal,
  confirmAction,
  openFullPlayer,
  openModal,
  renderAllMemosModal,
  renderEpisodeList,
  renderEpisodeMemos,
  renderPlayerUI,
  renderProgramTabs,
  renderSettingsModalContent,
  renderSleepTimerUI,
  renderToolbar,
  setupProgramColorPresets,
  showToast,
} from './ui.js';

export { showToast };

const PWA_BANNER_DISMISSED_KEY = 'PocketRadioPwaBannerDismissed_v1';

// アプリ全体で共有する状態
const appState = {
  meta: null,
  storageEstimate: null,
  isImporting: false,
  isSeeking: false,
  player: null,
  sleepTimer: {
    mode: 'off', // 'off' | 'minutes' | 'episode-end'
    minutes: null,
    endTimestamp: null,
    intervalId: null,
  },
  memoEditor: {
    editingMemoId: null,
    fileName: null,
    baseSec: 0,
    offsetMode: 'now', // 'now' | 'minus5'
  },
};

/**
 * 次の画面描画フレームまで待機する
 */
function waitNextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

/**
 * ブラウザのストレージ使用上限の目安を更新する
 */
async function refreshStorageEstimate() {
  appState.storageEstimate = await getStorageEstimate();
}

/**
 * Service Worker（オフライン受付係）を登録し、設定画面の状態表示を更新する
 */
async function registerServiceWorker() {
  const statusBadge = document.getElementById('sw-status-badge');

  if (window.location.protocol === 'file:') {
    if (statusBadge) {
      statusBadge.textContent = 'ローカル/GitHub Pages経由で有効';
      statusBadge.className = 'status-badge is-warning';
    }
    return;
  }

  if (!('serviceWorker' in navigator)) {
    if (statusBadge) {
      statusBadge.textContent = 'このブラウザは非対応';
      statusBadge.className = 'status-badge is-warning';
    }
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });

    const markReady = () => {
      if (statusBadge) {
        statusBadge.textContent = 'オフライン準備完了 ✓';
        statusBadge.className = 'status-badge is-ready';
      }
    };

    if (registration.active) {
      markReady();
    } else {
      if (statusBadge) {
        statusBadge.textContent = 'オフライン準備中...';
      }
      const worker = registration.installing || registration.waiting;
      if (worker) {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') {
            markReady();
          }
        });
      }
    }
  } catch (error) {
    console.error('Service Worker の登録に失敗しました:', error);
    if (statusBadge) {
      statusBadge.textContent = '登録エラー（通信環境を確認）';
      statusBadge.className = 'status-badge is-warning';
    }
  }
}

/**
 * OS（iOS/Android）に対して保存データが勝手に消えにくいよう保護を依頼する
 */
async function requestPersistentStorage() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      await navigator.storage.persist();
    }
  } catch (error) {
    console.warn('永続ストレージの要求はスキップされました:', error);
  }
}

/**
 * ホーム画面からPWAとして起動していない場合に、案内バナーを表示する
 */
function setupPwaInstallBanner() {
  const banner = document.getElementById('pwa-install-banner');
  const dismissBtn = document.getElementById('btn-dismiss-pwa-banner');
  if (!banner || !dismissBtn) return;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  let isDismissed = false;
  try {
    isDismissed = window.localStorage.getItem(PWA_BANNER_DISMISSED_KEY) === '1';
  } catch {
    isDismissed = false;
  }

  if (!isStandalone && !isDismissed) {
    banner.hidden = false;
  }

  dismissBtn.addEventListener('click', () => {
    banner.hidden = true;
    try {
      window.localStorage.setItem(PWA_BANNER_DISMISSED_KEY, '1');
    } catch {
      // 保存できなくても画面からは閉じる
    }
  });
}

/**
 * 起動時やバックアップ復元時のデータ整合性チェック：
 * IndexedDB（音声本体）と LocalStorage（メタ情報）に食い違いがあれば自動修復する
 */
async function reconcileStorageWithDb() {
  const meta = appState.meta;
  if (!meta) return;

  let changed = false;

  try {
    const dbKeys = new Set(await getAllAudioKeys());

    for (const episode of Object.values(meta.episodes)) {
      if (episode && episode.hasAudio && !dbKeys.has(episode.fileName)) {
        episode.hasAudio = false;
        changed = true;
      }
    }

    for (const fileName of dbKeys) {
      const existing = meta.episodes[fileName];
      if (!existing) {
        const record = await getAudioFile(fileName);
        if (!record) continue;

        const parsed = parseFileName(fileName, meta.programs);
        let duration = null;
        try {
          const buffer = await record.blob.arrayBuffer();
          const detected = detectAudioFormat(buffer, fileName, record.mimeType || '');
          duration = extractAudioDuration(buffer, detected);
        } catch {
          duration = null;
        }

        const isCompleted = meta.completedHistory.includes(fileName);
        meta.episodes[fileName] = {
          fileName,
          programKey: parsed.programKey,
          title: parsed.title,
          broadcastDate: parsed.broadcastDate,
          dayOfWeek: parsed.dayOfWeek,
          duration,
          currentTime: 0,
          status: isCompleted ? 'completed' : 'unplayed',
          fileSize: record.size || record.blob.size || 0,
          hasAudio: true,
          addedAt: record.addedAt || Date.now(),
          lastPlayedAt: null,
          completedAt: isCompleted ? Date.now() : null,
        };
        changed = true;
      } else if (!existing.hasAudio) {
        existing.hasAudio = true;
        changed = true;
      }
    }

    if (changed) {
      saveMeta(meta);
    }
  } catch (error) {
    console.error('データ整合性チェック中にエラーが発生しました:', error);
  }
}

// =========================================================================
// スリープタイマー制御（時刻ベース＋画面ロック対応）
// =========================================================================

function clearSleepTimer() {
  if (appState.sleepTimer.intervalId !== null) {
    window.clearInterval(appState.sleepTimer.intervalId);
    appState.sleepTimer.intervalId = null;
  }
  appState.sleepTimer.mode = 'off';
  appState.sleepTimer.minutes = null;
  appState.sleepTimer.endTimestamp = null;
  renderSleepTimerUI(appState.sleepTimer);
}

function checkSleepTimerExpiry() {
  const timer = appState.sleepTimer;
  if (timer.mode !== 'minutes' || !timer.endTimestamp) return;

  if (Date.now() >= timer.endTimestamp) {
    appState.player?.pause();
    clearSleepTimer();
    showToast('スリープタイマーにより再生を停止しました', 'info');
  }
}

function setSleepTimer(option) {
  clearSleepTimer();

  if (option === 'off') {
    showToast('スリープタイマーを解除しました', 'info');
    return;
  }

  if (option === 'episode-end') {
    appState.sleepTimer.mode = 'episode-end';
    renderSleepTimerUI(appState.sleepTimer);
    showToast('この回の終了時に再生を停止します', 'info');
    return;
  }

  const minutes = Number.parseInt(option, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  appState.sleepTimer.mode = 'minutes';
  appState.sleepTimer.minutes = minutes;
  appState.sleepTimer.endTimestamp = Date.now() + minutes * 60 * 1000;
  appState.sleepTimer.intervalId = window.setInterval(() => {
    checkSleepTimerExpiry();
    if (appState.sleepTimer.mode === 'minutes') {
      renderSleepTimerUI(appState.sleepTimer);
    }
  }, 1000);

  renderSleepTimerUI(appState.sleepTimer);
  showToast(`${minutes}分後に再生を停止します`, 'info');
}

// =========================================================================
// タイムスタンプ付きメモの追加・編集・削除・ジャンプ制御
// =========================================================================

function getMemoEditorResolvedSec() {
  const { baseSec, offsetMode } = appState.memoEditor;
  if (offsetMode === 'minus5') {
    return Math.max(0, Math.floor(baseSec - 5));
  }
  return Math.max(0, Math.floor(baseSec));
}

function syncMemoEditorTimeUI() {
  const preview = document.getElementById('memo-time-preview');
  const nowBtn = document.getElementById('btn-memo-time-now');
  const minus5Btn = document.getElementById('btn-memo-time-minus5');

  if (preview) {
    preview.textContent = formatDuration(getMemoEditorResolvedSec());
  }
  nowBtn?.classList.toggle('is-active', appState.memoEditor.offsetMode === 'now');
  minus5Btn?.classList.toggle('is-active', appState.memoEditor.offsetMode === 'minus5');
}

function openMemoEditor({ fileName, baseSec = 0, editingMemo = null }) {
  if (!fileName) {
    showToast('先にエピソードを選択してください', 'info');
    return;
  }

  appState.memoEditor = {
    editingMemoId: editingMemo ? editingMemo.id : null,
    fileName,
    baseSec: editingMemo ? editingMemo.timestampSec : Math.floor(baseSec || 0),
    offsetMode: 'now',
  };

  const titleEl = document.getElementById('memo-editor-title');
  const textInput = document.getElementById('memo-text-input');

  if (titleEl) {
    titleEl.textContent = editingMemo ? 'メモを編集' : 'タイムスタンプ付きメモ';
  }
  if (textInput) {
    textInput.value = editingMemo ? editingMemo.text : '';
  }

  syncMemoEditorTimeUI();
  openModal('modal-memo-editor');

  window.setTimeout(() => {
    textInput?.focus();
  }, 40);
}

function handleSaveMemoFromModal() {
  const textInput = document.getElementById('memo-text-input');
  const text = textInput?.value || '';
  const resolvedSec = getMemoEditorResolvedSec();
  const { editingMemoId, fileName } = appState.memoEditor;

  let result;
  if (editingMemoId) {
    result = updateMemo(appState.meta, editingMemoId, {
      text,
      timestampSec: resolvedSec,
    });
  } else {
    result = addMemo(appState.meta, {
      fileName,
      timestampSec: resolvedSec,
      text,
    });
  }

  if (!result.ok) {
    showToast(result.error, 'warning');
    return;
  }

  closeModal('modal-memo-editor');
  renderAll();
  showToast(
    editingMemoId
      ? 'メモを更新しました'
      : `${formatDuration(resolvedSec)} にメモを保存しました`,
    'success'
  );
}

async function handleJumpMemo(memo) {
  const ep = appState.meta?.episodes?.[memo.fileName];
  if (!ep || !ep.hasAudio) {
    showToast('この回の音声データは削除されているため再生できません', 'info');
    return;
  }

  closeModal('modal-all-memos');
  await appState.player?.loadEpisode(memo.fileName, {
    autoplay: true,
    startTime: memo.timestampSec,
  });
  showToast(`${formatDuration(memo.timestampSec)} から再生します`, 'info');
}

async function handleDeleteMemo(memo) {
  const ok = await confirmAction({
    title: 'メモを削除',
    message: `「${formatDuration(memo.timestampSec)}：${memo.text}」を削除しますか？`,
    okLabel: '削除する',
    isDanger: true,
  });

  if (!ok) return;

  if (deleteMemo(appState.meta, memo.id)) {
    renderAll();
    showToast('メモを削除しました', 'info');
  }
}

function renderAllMemosView() {
  const searchInput = document.getElementById('memo-search-input');
  const filterSelect = document.getElementById('memo-program-filter');

  renderAllMemosModal({
    meta: appState.meta,
    search: searchInput?.value || '',
    programKey: filterSelect?.value || 'all',
    handlers: {
      onJumpMemo: (memo) => handleJumpMemo(memo),
      onEditMemo: (memo) => openMemoEditor({ fileName: memo.fileName, editingMemo: memo }),
      onDeleteMemo: (memo) => handleDeleteMemo(memo),
    },
  });
}

// =========================================================================
// 一括音声削除・JSONバックアップ＆復元
// =========================================================================

async function handleBulkDeleteCompleted() {
  const targets = getDeletableCompletedEpisodes(appState.meta);
  if (targets.length === 0) {
    showToast('削除できる聴了済みの音声データはありません', 'info');
    return;
  }

  const totalBytes = targets.reduce((sum, ep) => sum + (Number(ep.fileSize) || 0), 0);
  const ok = await confirmAction({
    title: '聴了済みの音声を一括削除',
    message: `聴了済みの ${targets.length}本（${formatFileSize(totalBytes)}）の音声データを iPhone からまとめて削除しますか？\n（再生履歴・聴了記録・メモはそのまま残ります）`,
    okLabel: '一括削除して容量を空ける',
    isDanger: true,
  });

  if (!ok) return;

  try {
    const fileNames = targets.map((ep) => ep.fileName);
    for (const fileName of fileNames) {
      appState.player?.handleFileDeleted(fileName);
    }

    await deleteAudioFiles(fileNames);
    markEpisodesAudioDeleted(appState.meta, fileNames);
    await refreshStorageEstimate();
    renderAll();
    showToast(
      `${targets.length}本（${formatFileSize(totalBytes)}）を削除して容量を空けました`,
      'success'
    );
  } catch (error) {
    console.error('一括削除に失敗しました:', error);
    showToast('一括削除中にエラーが発生しました', 'warning');
  }
}

function handleExportJson() {
  try {
    const payload = createBackupPayload(appState.meta);
    const jsonText = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const fileName = `pocket-radio-backup-${yyyy}-${mm}-${dd}.json`;

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);

    showToast('バックアップファイルを書き出しました（iCloud Drive等に保管してください）', 'success');
  } catch (error) {
    console.error('バックアップの書き出しに失敗しました:', error);
    showToast('バックアップの書き出しに失敗しました', 'warning');
  }
}

async function handleImportJsonFile(file) {
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = parseAndValidateBackup(text);
    if (!parsed.ok) {
      showToast(parsed.error, 'warning');
      return;
    }

    const mode = await chooseBackupImportMode(parsed.summary);
    if (mode === 'cancel') return;

    if (mode === 'replace') {
      const confirmed = await confirmAction({
        title: 'バックアップで上書き',
        message:
          '現在の番組設定・メモ・聴了履歴がバックアップの内容で置き換わります（端末内の音声ファイル自体は消えません）。よろしいですか？',
        okLabel: '上書きして復元',
        isDanger: true,
      });
      if (!confirmed) return;
    }

    applyBackupData(appState.meta, parsed.data, mode);
    // 復元後、この端末に実際に保存されている音声ファイルと突合して整合性を合わせる
    await reconcileStorageWithDb();
    await refreshStorageEstimate();

    appState.player?.refreshMetadata();
    renderAll();

    showToast(
      mode === 'merge'
        ? 'バックアップを現在のデータに統合しました ✓'
        : 'バックアップからデータを復元しました ✓',
      'success'
    );
  } catch (error) {
    console.error('バックアップの復元に失敗しました:', error);
    showToast('バックアップファイルの読み込みに失敗しました', 'warning');
  }
}

// =========================================================================
// 番組マッピング・エピソード操作
// =========================================================================

function openProgramForm({ editingKey = null, key = '', name = '', color = PROGRAM_COLOR_PRESETS[0] } = {}) {
  const form = document.getElementById('program-form');
  const keyInput = document.getElementById('program-key-input');
  const nameInput = document.getElementById('program-name-input');
  const colorInput = document.getElementById('program-color-input');
  if (!form || !keyInput || !nameInput || !colorInput) return;

  form.dataset.editingKey = editingKey || '';
  keyInput.value = key;
  keyInput.disabled = editingKey === '_other';
  nameInput.value = name;
  colorInput.value = color || PROGRAM_COLOR_PRESETS[0];
  colorInput.dispatchEvent(new Event('input'));

  form.hidden = false;
  if (!keyInput.disabled && !key) {
    keyInput.focus();
  } else {
    nameInput.focus();
  }
}

function closeProgramForm() {
  const form = document.getElementById('program-form');
  const keyInput = document.getElementById('program-key-input');
  if (!form) return;
  form.hidden = true;
  form.dataset.editingKey = '';
  if (keyInput) keyInput.disabled = false;
  form.reset();
}

async function handleDeleteEpisodeAudio(episode) {
  const ok = await confirmAction({
    title: '音声データを削除',
    message: `「${episode.title}」の音声データ（${formatFileSize(episode.fileSize)}）を iPhone から削除しますか？\n（再生履歴・聴了記録・メモはそのまま残ります）`,
    okLabel: '削除して容量を空ける',
    isDanger: true,
  });

  if (!ok) return;

  try {
    appState.player?.handleFileDeleted(episode.fileName);

    await deleteAudioFile(episode.fileName);
    markEpisodeAudioDeleted(appState.meta, episode.fileName);
    await refreshStorageEstimate();
    renderAll();
    showToast('音声データを削除して容量を空けました', 'success');
  } catch (error) {
    console.error('音声データの削除に失敗しました:', error);
    showToast('音声データの削除に失敗しました', 'warning');
  }
}

async function handleRevokeCompleted(fileName) {
  const ok = await confirmAction({
    title: '聴了記録を取り消す',
    message: `「${fileName}」の聴了記録を取り消しますか？\n次回 iCloud から同じファイルを選ぶと再度取り込めるようになります。`,
    okLabel: '取り消す',
    isDanger: false,
  });

  if (!ok) return;

  revokeEpisodeCompleted(appState.meta, fileName);
  renderAll();
  appState.player?.refreshMetadata();
  showToast('聴了記録を取り消しました（再取り込み可能です）', 'info');
}

async function handleDeleteProgram(program) {
  const ok = await confirmAction({
    title: '番組設定を削除',
    message: `「${program.name}（${program.key}）」の設定を削除しますか？\n取り込み済みのエピソード自体は削除されません。`,
    okLabel: '削除する',
    isDanger: true,
  });

  if (!ok) return;

  const res = deleteProgramMapping(appState.meta, program.key);
  if (res.ok) {
    renderAll();
    appState.player?.refreshMetadata();
    showToast(`「${program.name}」の設定を削除しました`, 'info');
  }
}

async function handleSelectEpisode(ep) {
  if (!ep.hasAudio) {
    showToast('この回の音声データは削除されています', 'info');
    return;
  }

  const player = appState.player;
  if (!player) return;

  const state = player.getState();
  if (state.fileName === ep.fileName && state.isLoaded) {
    if (state.isPlaying) {
      openFullPlayer();
    } else {
      await player.togglePlayPause();
    }
    return;
  }

  await player.loadEpisode(ep.fileName, { autoplay: true });
}

async function handleOpenEpisodeMemos(ep) {
  if (ep.hasAudio && appState.player) {
    const state = appState.player.getState();
    if (state.fileName !== ep.fileName || !state.isLoaded) {
      await appState.player.loadEpisode(ep.fileName, { autoplay: false });
    }
    openFullPlayer();
    const memosBox = document.getElementById('full-episode-memos');
    memosBox?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const searchInput = document.getElementById('memo-search-input');
  const filterSelect = document.getElementById('memo-program-filter');
  if (searchInput) searchInput.value = ep.fileName;
  if (filterSelect) filterSelect.value = 'all';
  renderAllMemosView();
  openModal('modal-all-memos');
}

/**
 * 設定モーダル内のみ再描画する（聴了履歴の検索入力用）
 */
function renderSettingsView() {
  const historySearch = document.getElementById('history-search-input')?.value || '';
  renderSettingsModalContent({
    meta: appState.meta,
    storageEstimate: appState.storageEstimate,
    historySearch,
    handlers: {
      onQuickSetupProgram: (key) => {
        openProgramForm({
          editingKey: null,
          key,
          name: '',
          color: PROGRAM_COLOR_PRESETS[0],
        });
      },
      onEditProgram: (prog) => {
        openProgramForm({
          editingKey: prog.key,
          key: prog.key,
          name: prog.name,
          color: prog.color,
        });
      },
      onDeleteProgram: (prog) => handleDeleteProgram(prog),
      onRevokeCompleted: (fileName) => handleRevokeCompleted(fileName),
    },
  });
}

/**
 * プレイヤーUIだけを高頻度で軽量更新する（再生中の毎秒の進捗表示用）
 */
function refreshPlayerView(snapshot) {
  renderPlayerUI({
    meta: appState.meta,
    snapshot: snapshot || appState.player?.getState(),
    isSeeking: appState.isSeeking,
  });
}

/**
 * アプリ全体の画面（タブ・ツールバー・エピソード一覧・設定・プレイヤー・メモ）を描き直す
 */
function renderAll() {
  const meta = appState.meta;
  if (!meta) return;

  const tabs = buildProgramTabs(meta);

  let activeProgramTab = meta.settings?.activeProgramTab || 'all';
  if (!tabs.some((tab) => tab.key === activeProgramTab)) {
    activeProgramTab = 'all';
    updateSettings(meta, { activeProgramTab: 'all' });
  }

  const activeFilter = meta.settings?.activeFilter || 'playable';
  const sortOrder = meta.settings?.sortOrder || 'desc';
  const selectedTab = tabs.find((tab) => tab.key === activeProgramTab) || tabs[0];
  const filteredEpisodes = filterAndSortEpisodes(meta, {
    programTab: activeProgramTab,
    filter: activeFilter,
    sortOrder,
  });

  const playerState = appState.player?.getState() || { fileName: null, isPlaying: false };

  renderProgramTabs(tabs, activeProgramTab, (nextKey) => {
    updateSettings(meta, { activeProgramTab: nextKey });
    renderAll();
  });

  renderToolbar({
    selectedTab,
    filter: activeFilter,
    sortOrder,
  });

  renderEpisodeList({
    meta,
    episodes: filteredEpisodes,
    activeProgramTab,
    activeFilter,
    playingFileName: playerState.fileName,
    isPlaying: playerState.isPlaying,
    handlers: {
      onSelectEpisode: (ep) => handleSelectEpisode(ep),
      onDeleteAudio: (ep) => handleDeleteEpisodeAudio(ep),
      onRevokeCompleted: (fileName) => handleRevokeCompleted(fileName),
      onOpenEpisodeMemos: (ep) => handleOpenEpisodeMemos(ep),
      onResetFilter: () => {
        updateSettings(meta, { activeFilter: 'all' });
        renderAll();
      },
    },
  });

  renderSettingsView();
  refreshPlayerView(playerState);
  renderSleepTimerUI(appState.sleepTimer);

  const episodeMemos = getEpisodeMemos(meta, playerState.fileName);
  renderEpisodeMemos({
    memos: episodeMemos,
    handlers: {
      onJumpMemo: (memo) => handleJumpMemo(memo),
      onEditMemo: (memo) => openMemoEditor({ fileName: memo.fileName, editingMemo: memo }),
      onDeleteMemo: (memo) => handleDeleteMemo(memo),
    },
  });

  const allMemosModal = document.getElementById('modal-all-memos');
  if (allMemosModal && !allMemosModal.hidden) {
    renderAllMemosView();
  }
}

/**
 * 取り込み進捗インジケーターを更新する
 */
function updateImportProgress(visible, text = '', current = 0, total = 0) {
  const box = document.getElementById('import-progress');
  const textEl = document.getElementById('import-progress-text');
  const countEl = document.getElementById('import-progress-count');
  const barEl = document.getElementById('import-progress-bar');
  if (!box) return;

  box.hidden = !visible;
  if (!visible) return;

  if (textEl) textEl.textContent = text;
  if (countEl) countEl.textContent = `${current} / ${total}`;
  if (barEl) {
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    barEl.style.width = `${percent}%`;
  }
}

/**
 * 選択された複数の音声ファイルを 1本ずつ順番（直列）に取り込む
 * @param {FileList | null} fileList
 */
async function handleSelectedFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  if (appState.isImporting) {
    showToast('現在ほかのファイルを取り込み中です', 'warning');
    return;
  }

  const meta = appState.meta;
  if (!meta) return;

  const files = Array.from(fileList);
  appState.isImporting = true;

  const summary = {
    added: 0,
    skippedExisting: 0,
    skippedCompleted: 0,
    skippedUnsupported: 0,
    failed: 0,
    quotaExceeded: false,
  };

  try {
    updateImportProgress(true, 'iCloud からファイルを準備しています...', 0, files.length);
    await waitNextFrame();

    const existingDbKeys = new Set(await getAllAudioKeys());
    const completedSet = new Set(meta.completedHistory || []);

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      updateImportProgress(
        true,
        `取り込み中 (${i + 1} / ${files.length}本) - ${file.name}`,
        i + 1,
        files.length
      );
      await waitNextFrame();

      if (existingDbKeys.has(file.name)) {
        summary.skippedExisting += 1;
        continue;
      }
      if (completedSet.has(file.name)) {
        summary.skippedCompleted += 1;
        continue;
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        const detected = detectAudioFormat(arrayBuffer, file.name, file.type);

        if (!detected.isAudio) {
          summary.skippedUnsupported += 1;
          continue;
        }

        const parsed = parseFileName(file.name, meta.programs);
        const duration = extractAudioDuration(arrayBuffer, detected);
        const audioBlob = new Blob([arrayBuffer], { type: detected.mimeType });
        const now = Date.now();

        await saveAudioFile({
          fileName: file.name,
          blob: audioBlob,
          size: audioBlob.size,
          mimeType: detected.mimeType,
          addedAt: now,
        });

        const previousEpisode = meta.episodes[file.name];
        const episode = previousEpisode
          ? {
              ...previousEpisode,
              programKey: parsed.programKey,
              title: parsed.title,
              broadcastDate: parsed.broadcastDate,
              dayOfWeek: parsed.dayOfWeek,
              duration: duration ?? previousEpisode.duration ?? null,
              fileSize: audioBlob.size,
              hasAudio: true,
              addedAt: now,
            }
          : {
              fileName: file.name,
              programKey: parsed.programKey,
              title: parsed.title,
              broadcastDate: parsed.broadcastDate,
              dayOfWeek: parsed.dayOfWeek,
              duration,
              currentTime: 0,
              status: 'unplayed',
              fileSize: audioBlob.size,
              hasAudio: true,
              addedAt: now,
              lastPlayedAt: null,
              completedAt: null,
            };

        upsertEpisode(meta, episode);
        existingDbKeys.add(file.name);
        summary.added += 1;
      } catch (error) {
        if (isQuotaExceededError(error)) {
          summary.quotaExceeded = true;
          break;
        }
        console.error(`ファイルの取り込みに失敗 (${file.name}):`, error);
        summary.failed += 1;
      }
    }
  } finally {
    appState.isImporting = false;
    updateImportProgress(false);
    await refreshStorageEstimate();
    renderAll();
  }

  if (summary.quotaExceeded) {
    showToast(
      `iPhoneの空き容量が不足しているため中断しました（${summary.added}本保存）。聴了済みの音声を削除してください。`,
      'warning'
    );
    return;
  }

  const skipParts = [];
  if (summary.skippedExisting > 0) skipParts.push(`保存済み ${summary.skippedExisting}本`);
  if (summary.skippedCompleted > 0) skipParts.push(`聴了済み ${summary.skippedCompleted}本`);
  if (summary.skippedUnsupported > 0) skipParts.push(`非対応 ${summary.skippedUnsupported}本`);
  if (summary.failed > 0) skipParts.push(`失敗 ${summary.failed}本`);

  if (summary.added > 0) {
    const suffix = skipParts.length > 0 ? `（スキップ: ${skipParts.join(' / ')}）` : '';
    showToast(`新規 ${summary.added}本を取り込みました${suffix}`, 'success');
  } else if (skipParts.length > 0) {
    showToast(`新しい音声はありませんでした（${skipParts.join(' / ')}）`, 'info');
  }
}

/**
 * モーダル・ツールバー・プレイヤー・タイマー・メモ・番組設定・バックアップの操作を紐づける
 */
function setupInteractions() {
  document.getElementById('btn-open-settings')?.addEventListener('click', async () => {
    await refreshStorageEstimate();
    renderAll();
    openModal('modal-settings');
  });

  document.getElementById('btn-open-all-memos')?.addEventListener('click', () => {
    renderAllMemosView();
    openModal('modal-all-memos');
  });

  document.getElementById('memo-search-input')?.addEventListener('input', () => {
    renderAllMemosView();
  });
  document.getElementById('memo-program-filter')?.addEventListener('change', () => {
    renderAllMemosView();
  });
  document.getElementById('history-search-input')?.addEventListener('input', () => {
    renderSettingsView();
  });

  document.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', () => {
      const targetId = el.getAttribute('data-close-modal');
      if (
        targetId &&
        targetId !== 'modal-confirm' &&
        targetId !== 'modal-backup-import'
      ) {
        closeModal(targetId);
      }
    });
  });

  // フルプレイヤーの開閉
  document.getElementById('btn-expand-player')?.addEventListener('click', () => {
    openFullPlayer();
  });
  document.getElementById('btn-close-full-player')?.addEventListener('click', () => {
    closeFullPlayer();
  });
  document.querySelector('[data-close-sheet="full-player"]')?.addEventListener('click', () => {
    closeFullPlayer();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.modal:not([hidden])').forEach((modal) => {
      if (modal.id !== 'modal-confirm' && modal.id !== 'modal-backup-import') {
        closeModal(modal.id);
      }
    });
    const fullSheet = document.getElementById('full-player-sheet');
    if (fullSheet && !fullSheet.hidden) {
      closeFullPlayer();
    }
  });

  // フィルターチップ切り替え
  document.querySelectorAll('#filter-chips .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const nextFilter = chip.getAttribute('data-filter') || 'playable';
      updateSettings(appState.meta, { activeFilter: nextFilter });
      renderAll();
    });
  });

  // 並び順トグル
  document.getElementById('btn-toggle-sort')?.addEventListener('click', () => {
    const currentOrder = appState.meta?.settings?.sortOrder || 'desc';
    const nextOrder = currentOrder === 'desc' ? 'asc' : 'desc';
    updateSettings(appState.meta, { sortOrder: nextOrder });
    renderAll();
  });

  // 連続再生スイッチ
  document.getElementById('toggle-autoplay-next')?.addEventListener('change', (event) => {
    updateSettings(appState.meta, { autoPlayNext: event.target.checked });
    showToast(event.target.checked ? '連続再生をONにしました' : '連続再生をOFFにしました', 'info');
  });

  // ミニ／フルプレイヤーの操作ボタン
  document.getElementById('btn-mini-play')?.addEventListener('click', () => {
    appState.player?.togglePlayPause();
  });
  document.getElementById('btn-full-play')?.addEventListener('click', () => {
    appState.player?.togglePlayPause();
  });
  document.getElementById('btn-mini-back')?.addEventListener('click', () => {
    appState.player?.seekBy(-15);
  });
  document.getElementById('btn-full-back')?.addEventListener('click', () => {
    appState.player?.seekBy(-15);
  });
  document.getElementById('btn-mini-forward')?.addEventListener('click', () => {
    appState.player?.seekBy(30);
  });
  document.getElementById('btn-full-forward')?.addEventListener('click', () => {
    appState.player?.seekBy(30);
  });

  // 再生速度の順送り切り替え
  document.getElementById('btn-playback-rate')?.addEventListener('click', () => {
    const nextRate = appState.player?.cyclePlaybackRate();
    if (nextRate) {
      showToast(`再生速度を ${nextRate}x に変更しました`, 'info');
    }
  });

  // フルプレイヤーの「聴了にする／未聴に戻す」
  document.getElementById('btn-toggle-complete')?.addEventListener('click', () => {
    const fileName = appState.player?.getState().fileName;
    const ep = fileName ? appState.meta?.episodes?.[fileName] : null;
    if (!ep) return;

    if (ep.status === 'completed') {
      revokeEpisodeCompleted(appState.meta, fileName);
      showToast('未聴・途中に戻しました', 'info');
    } else {
      markEpisodeCompleted(appState.meta, fileName);
      showToast('「聴了」にしました ✓', 'success');
    }
    renderAll();
  });

  // スリープタイマーモーダル＆選択肢
  document.getElementById('btn-sleep-timer')?.addEventListener('click', () => {
    renderSleepTimerUI(appState.sleepTimer);
    openModal('modal-sleep-timer');
  });

  document.querySelectorAll('#modal-sleep-timer [data-sleep-option]').forEach((optionBtn) => {
    optionBtn.addEventListener('click', () => {
      const option = optionBtn.getAttribute('data-sleep-option') || 'off';
      setSleepTimer(option);
      closeModal('modal-sleep-timer');
    });
  });

  // 「＋ メモ」追加＆編集モーダル
  document.getElementById('btn-add-memo')?.addEventListener('click', () => {
    const state = appState.player?.getState();
    if (!state?.fileName) {
      showToast('先にエピソードを選択してください', 'info');
      return;
    }
    openMemoEditor({
      fileName: state.fileName,
      baseSec: state.currentTime || 0,
    });
  });

  document.getElementById('btn-memo-time-now')?.addEventListener('click', () => {
    appState.memoEditor.offsetMode = 'now';
    syncMemoEditorTimeUI();
  });
  document.getElementById('btn-memo-time-minus5')?.addEventListener('click', () => {
    appState.memoEditor.offsetMode = 'minus5';
    syncMemoEditorTimeUI();
  });
  document.getElementById('btn-save-memo')?.addEventListener('click', () => {
    handleSaveMemoFromModal();
  });
  document.getElementById('memo-text-input')?.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSaveMemoFromModal();
    }
  });

  // シークバーのドラッグ＆移動プレビュー
  const seekBar = document.getElementById('full-seek-bar');
  if (seekBar) {
    const updateSeekPreview = () => {
      const targetSec = Number(seekBar.value);
      const duration = appState.player?.getState().duration || 0;
      const curEl = document.getElementById('full-current-time');
      const remEl = document.getElementById('full-remaining-time');

      if (curEl) curEl.textContent = formatDuration(targetSec);
      if (remEl && duration > 0) {
        const remaining = Math.max(0, duration - targetSec);
        remEl.textContent = `-${formatDuration(remaining)} / ${formatDuration(duration)}`;
      }
    };

    seekBar.addEventListener('pointerdown', () => {
      appState.isSeeking = true;
    });
    seekBar.addEventListener('touchstart', () => {
      appState.isSeeking = true;
    }, { passive: true });

    seekBar.addEventListener('input', () => {
      appState.isSeeking = true;
      updateSeekPreview();
    });

    seekBar.addEventListener('change', () => {
      const targetSec = Number(seekBar.value);
      appState.isSeeking = false;
      appState.player?.seekTo(targetSec);
    });

    const releaseSeek = () => {
      appState.isSeeking = false;
    };
    seekBar.addEventListener('pointerup', releaseSeek);
    seekBar.addEventListener('pointercancel', releaseSeek);
    seekBar.addEventListener('touchend', releaseSeek);
  }

  // 番組マッピング追加・編集フォーム
  setupProgramColorPresets();
  document.getElementById('btn-open-program-form')?.addEventListener('click', () => {
    openProgramForm();
  });
  document.getElementById('btn-cancel-program-form')?.addEventListener('click', () => {
    closeProgramForm();
  });
  document.getElementById('program-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const editingKey = form.dataset.editingKey || null;
    const key = document.getElementById('program-key-input')?.value || '';
    const name = document.getElementById('program-name-input')?.value || '';
    const color = document.getElementById('program-color-input')?.value || '#34d399';

    const result = saveProgramMapping(appState.meta, {
      originalKey: editingKey,
      key,
      name,
      color,
    });

    if (!result.ok) {
      showToast(result.error, 'warning');
      return;
    }

    closeProgramForm();
    renderAll();
    appState.player?.refreshMetadata();
    showToast(`番組「${result.program.name}」を保存しました`, 'success');
  });

  // ファイル取り込みボタンを <input type="file"> に接続
  const audioInput = document.getElementById('file-input-audio');
  const anyInput = document.getElementById('file-input-any');
  const backupInput = document.getElementById('file-input-backup');

  document.getElementById('btn-add-files')?.addEventListener('click', () => {
    audioInput?.click();
  });
  document.getElementById('btn-empty-add')?.addEventListener('click', () => {
    audioInput?.click();
  });
  document.getElementById('btn-add-files-any')?.addEventListener('click', () => {
    closeModal('modal-settings');
    anyInput?.click();
  });

  audioInput?.addEventListener('change', async (event) => {
    const input = event.target;
    try {
      await handleSelectedFiles(input.files);
    } finally {
      input.value = '';
    }
  });

  anyInput?.addEventListener('change', async (event) => {
    const input = event.target;
    try {
      await handleSelectedFiles(input.files);
    } finally {
      input.value = '';
    }
  });

  // Phase 6：一括容量解放・JSONバックアップ＆復元
  document.getElementById('btn-bulk-delete-completed')?.addEventListener('click', () => {
    handleBulkDeleteCompleted();
  });
  document.getElementById('btn-export-json')?.addEventListener('click', () => {
    handleExportJson();
  });
  document.getElementById('btn-import-json')?.addEventListener('click', () => {
    backupInput?.click();
  });
  backupInput?.addEventListener('change', async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    try {
      await handleImportJsonFile(file);
    } finally {
      input.value = '';
    }
  });
}

/**
 * アプリ起動時の初期化処理
 */
async function initApp() {
  appState.meta = loadMeta();
  mergePlaybackIntoMeta(appState.meta);

  const audioElement = document.getElementById('audio-player');
  let lastRenderedPlayKey = '';

  appState.player = createAudioPlayer({
    audioElement,
    getMeta: () => appState.meta,
    callbacks: {
      onStateChange: (snapshot) => {
        refreshPlayerView(snapshot);
        const nextPlayKey = `${snapshot.fileName || ''}:${snapshot.isPlaying}`;
        if (nextPlayKey !== lastRenderedPlayKey) {
          lastRenderedPlayKey = nextPlayKey;
          renderAll();
        }
      },
      onBeforeAutoPlayNext: () => {
        if (appState.sleepTimer.mode === 'episode-end') {
          clearSleepTimer();
          showToast('この回の終了に合わせて停止しました', 'info');
          return false;
        }
        return true;
      },
      onEpisodeCompleted: (fileName) => {
        const ep = appState.meta?.episodes?.[fileName];
        if (ep) {
          showToast(`「${ep.title}」を聴了にしました ✓`, 'success');
        }
      },
      onMetaUpdated: () => {
        renderAll();
      },
      onError: (msg) => {
        showToast(msg, 'warning');
      },
    },
  });

  appState.player.onTimeTick(() => {
    checkSleepTimerExpiry();
  });

  setupPwaInstallBanner();
  setupInteractions();
  registerServiceWorker();
  requestPersistentStorage();

  await reconcileStorageWithDb();
  await refreshStorageEstimate();

  const resumeCandidate = findResumeCandidateEpisode(appState.meta);
  if (resumeCandidate) {
    appState.player.prepareStandby(resumeCandidate.fileName);
  }

  renderAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
