/**
 * Pocket Radio 音声再生エンジン（player.js）
 * 役割：
 *  1. 1つの <audio> 要素だけを使い回し、iPhoneのバックグラウンド再生を安定させる
 *  2. 音声データ（Blob）を一時URL（ObjectURL）に変換し、切り替え時に古いURLを必ず解放する
 *  3. 終了30秒前に次のエピソードを先読みし、待ち時間ゼロで連続再生する
 *  4. ロック画面・コントロールセンター・イヤホン操作（Media Session API）を連携する
 *  5. 再生中の現在位置を 3秒ごと＋停止・アプリ切替時に即時保存する
 */

import { getAudioFile } from './db.js';
import {
  clearPlayback,
  findNextPlayableEpisode,
  getNextPlaybackRate,
  getProgramDisplayInfo,
  markEpisodeCompleted,
  savePlayback,
  updateEpisodeProgress,
  updateSettings,
} from './storage.js';

const PRELOAD_THRESHOLD_SECONDS = 30;
const RESUME_SAVE_INTERVAL_MS = 3000;

/**
 * ロック画面用の番組カラーアートワーク（PNG Data URL）を Canvas で生成する
 * ※iOS Safari のロック画面は SVG 画像を表示できないため、PNG に変換します
 */
function createProgramArtworkDataUrl(color, labelText) {
  try {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // 暗い濃紺グラデーション背景
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#0b0f19');
    grad.addColorStop(1, '#17253f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // 番組カラーの柔らかい光
    ctx.fillStyle = `${color}28`;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 96, 0, Math.PI * 2);
    ctx.fill();

    // ラジオ電波ウェーブ
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(size / 2, 108, 34, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.stroke();

    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(size / 2, 108, 54, -Math.PI * 0.68, -Math.PI * 0.32);
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // ラジオ本体
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(68, 122, 120, 72, 18);
    ctx.fill();

    ctx.fillStyle = '#0d1422';
    ctx.beginPath();
    ctx.roundRect(78, 132, 100, 52, 12);
    ctx.fill();

    // スピーカー円
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(105, 158, 15, 0, Math.PI * 2);
    ctx.stroke();

    // 番組名の頭文字を右側の表示部へ控えめに描画
    ctx.fillStyle = '#f1f5f9';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const shortChar = Array.from(String(labelText || 'R'))[0] || 'R';
    ctx.fillText(shortChar, 152, 158);

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * 単一 <audio> 要素を制御するプレイヤーを作成する
 * @param {{
 *   audioElement: HTMLAudioElement,
 *   getMeta: () => any,
 *   callbacks?: {
 *     onStateChange?: (snapshot: any) => void,
 *     onEpisodeCompleted?: (fileName: string) => void,
 *     onError?: (message: string) => void,
 *     onMetaUpdated?: () => void,
 *   }
 * }} config
 */
export function createAudioPlayer({ audioElement, getMeta, callbacks = {} }) {
  let currentFileName = null;
  let currentObjectUrl = null;
  let preloaded = null; // { fileName: string, objectUrl: string } | null
  let isPreloading = false;
  let pendingSeekTime = null;
  let lastSavedAt = 0;
  let loadRequestToken = 0;

  // Phase 5 のスリープタイマー等が再生経過を受け取るためのリスナー集合
  const timeTickListeners = new Set();
  // 番組ごとのアートワーク Data URL キャッシュ
  const artworkCache = new Map();

  function revokeUrl(url) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // すでに解放済みの場合は無視
      }
    }
  }

  function clearPreload() {
    if (preloaded) {
      revokeUrl(preloaded.objectUrl);
      preloaded = null;
    }
    isPreloading = false;
  }

  function getSavedPlaybackRate() {
    const rate = getMeta()?.settings?.playbackRate;
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1.0;
  }

  function getCurrentDuration() {
    if (
      audioElement &&
      Number.isFinite(audioElement.duration) &&
      audioElement.duration > 0
    ) {
      return audioElement.duration;
    }
    const ep = currentFileName ? getMeta()?.episodes?.[currentFileName] : null;
    return ep && typeof ep.duration === 'number' && ep.duration > 0 ? ep.duration : 0;
  }

  function getCurrentTimeValue() {
    if (currentObjectUrl && audioElement) {
      return Number.isFinite(audioElement.currentTime) ? audioElement.currentTime : 0;
    }
    const ep = currentFileName ? getMeta()?.episodes?.[currentFileName] : null;
    return ep && typeof ep.currentTime === 'number' ? ep.currentTime : 0;
  }

  function getSnapshot() {
    return {
      fileName: currentFileName,
      isLoaded: Boolean(currentObjectUrl),
      isPlaying: Boolean(currentObjectUrl && !audioElement.paused && !audioElement.ended),
      currentTime: getCurrentTimeValue(),
      duration: getCurrentDuration(),
      playbackRate: getSavedPlaybackRate(),
    };
  }

  function emitStateChange() {
    callbacks.onStateChange?.(getSnapshot());
  }

  /**
   * Media Session API の現在再生位置（シークバー）を同期する
   */
  function updateMediaSessionPositionState() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') {
      return;
    }
    const duration = audioElement.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }
    const position = Math.max(0, Math.min(duration, audioElement.currentTime || 0));
    const rate = audioElement.playbackRate > 0 ? audioElement.playbackRate : 1.0;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position,
      });
    } catch {
      // iOSの一時的な遷移状態でエラーが出ても再生自体は止めない
    }
  }

  /**
   * ロック画面・コントロールセンターに表示する番組タイトルとアートワークを更新する
   */
  function updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') {
      return;
    }
    if (!currentFileName) {
      navigator.mediaSession.metadata = null;
      return;
    }

    const meta = getMeta();
    const ep = meta?.episodes?.[currentFileName];
    if (!ep) return;

    const program = getProgramDisplayInfo(meta, ep.programKey);
    const cacheKey = `${program.color}:${program.name}`;
    let artworkUrl = artworkCache.get(cacheKey);
    if (!artworkUrl) {
      artworkUrl = createProgramArtworkDataUrl(program.color, program.name);
      if (artworkUrl) {
        artworkCache.set(cacheKey, artworkUrl);
      }
    }

    const artwork = artworkUrl
      ? [{ src: artworkUrl, sizes: '256x256', type: 'image/png' }]
      : [];

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: ep.title || ep.fileName,
      artist: program.name,
      album: 'Pocket Radio',
      artwork,
    });
  }

  /**
   * 現在の再生位置を LocalStorage へ確実に保存する
   */
  function persistCurrentPosition({ saveFullMeta = false } = {}) {
    if (!currentFileName || !currentObjectUrl) return;
    const meta = getMeta();
    if (!meta) return;

    const currentTime = Number.isFinite(audioElement.currentTime) ? audioElement.currentTime : 0;
    const duration =
      Number.isFinite(audioElement.duration) && audioElement.duration > 0
        ? audioElement.duration
        : undefined;

    savePlayback(currentFileName, currentTime);
    updateEpisodeProgress(meta, currentFileName, {
      currentTime,
      duration,
      persist: saveFullMeta,
    });
    lastSavedAt = Date.now();
  }

  /**
   * 再生終了30秒前になったら、次の未聴エピソードをメモリに先読みしておく
   */
  async function maybePreloadNext() {
    const meta = getMeta();
    if (!meta?.settings?.autoPlayNext || !currentFileName || !currentObjectUrl) {
      return;
    }

    const duration = audioElement.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const remaining = duration - audioElement.currentTime;
    if (remaining > PRELOAD_THRESHOLD_SECONDS && duration > PRELOAD_THRESHOLD_SECONDS) {
      return;
    }

    const nextEp = findNextPlayableEpisode(meta, currentFileName);
    if (!nextEp) {
      clearPreload();
      return;
    }

    if (preloaded && preloaded.fileName === nextEp.fileName) {
      return;
    }
    if (isPreloading) {
      return;
    }

    clearPreload();
    isPreloading = true;
    const targetName = nextEp.fileName;

    try {
      const record = await getAudioFile(targetName);
      // 読み込み待ちの間に別操作が入っていないか確認
      if (!currentFileName || !getMeta()?.settings?.autoPlayNext) {
        return;
      }
      if (!record || !record.blob) return;

      const objectUrl = URL.createObjectURL(record.blob);
      preloaded = {
        fileName: targetName,
        objectUrl,
      };
    } catch (error) {
      console.warn('次のエピソードの先読みに失敗しました:', error);
    } finally {
      isPreloading = false;
    }
  }

  /**
   * 再生を完全停止し、読み込んでいる音声URLをすべて解放する
   */
  function stopAndUnload() {
    loadRequestToken += 1;
    audioElement.pause();
    clearPreload();
    revokeUrl(currentObjectUrl);
    currentObjectUrl = null;
    currentFileName = null;
    pendingSeekTime = null;

    audioElement.removeAttribute('src');
    audioElement.load();

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    }

    emitStateChange();
  }

  /**
   * 再生を開始する（iOSの自動再生ブロック時は親切に案内を返す）
   */
  async function safePlay() {
    try {
      audioElement.playbackRate = getSavedPlaybackRate();
      await audioElement.play();
      return true;
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        callbacks.onError?.('再生ボタンを押して再生を開始してください');
      } else if (error?.name !== 'AbortError') {
        console.error('音声の再生に失敗しました:', error);
        callbacks.onError?.('この音声ファイルを再生できませんでした');
      }
      emitStateChange();
      return false;
    }
  }

  /**
   * 指定したエピソードを読み込み、必要に応じてすぐ再生する
   * @param {string} fileName
   * @param {{ autoplay?: boolean, startTime?: number | null }} options
   */
  async function loadEpisode(fileName, { autoplay = true, startTime = null } = {}) {
    const meta = getMeta();
    const ep = meta?.episodes?.[fileName];
    if (!ep || !ep.hasAudio) {
      callbacks.onError?.('この回の音声データが見つかりません');
      return false;
    }

    // すでに同じ曲がロード済みなら再読込せずシーク・再生だけ行う
    if (currentFileName === fileName && currentObjectUrl) {
      if (typeof startTime === 'number' && Number.isFinite(startTime)) {
        seekTo(startTime);
      }
      if (autoplay) {
        await safePlay();
      } else {
        emitStateChange();
      }
      return true;
    }

    const token = ++loadRequestToken;

    try {
      // 再生位置の決定（聴了済みの回を最初から再生する場合は0秒から）
      const threshold = meta.settings?.completedThreshold ?? 0.95;
      let targetStartTime = 0;
      if (typeof startTime === 'number' && Number.isFinite(startTime)) {
        targetStartTime = Math.max(0, startTime);
      } else if (
        ep.status === 'completed' &&
        typeof ep.duration === 'number' &&
        ep.duration > 0 &&
        ep.currentTime >= ep.duration * threshold
      ) {
        targetStartTime = 0;
      } else {
        targetStartTime = Math.max(0, Number(ep.currentTime) || 0);
      }

      let nextObjectUrl = null;
      if (preloaded && preloaded.fileName === fileName) {
        nextObjectUrl = preloaded.objectUrl;
        preloaded = null;
      } else {
        clearPreload();
        const record = await getAudioFile(fileName);
        if (token !== loadRequestToken) {
          return false;
        }
        if (!record || !record.blob) {
          callbacks.onError?.('音声データが見つかりませんでした');
          return false;
        }
        nextObjectUrl = URL.createObjectURL(record.blob);
      }

      const oldUrl = currentObjectUrl;
      currentObjectUrl = nextObjectUrl;
      currentFileName = fileName;
      pendingSeekTime = targetStartTime > 0 ? targetStartTime : null;

      audioElement.src = nextObjectUrl;
      audioElement.playbackRate = getSavedPlaybackRate();

      // 古い ObjectURL を即座に解放してメモリリークを防ぐ
      if (oldUrl && oldUrl !== nextObjectUrl) {
        revokeUrl(oldUrl);
      }

      updateMediaSessionMetadata();
      emitStateChange();

      if (autoplay) {
        await safePlay();
      }
      return true;
    } catch (error) {
      console.error('エピソードの読み込みに失敗しました:', error);
      callbacks.onError?.('音声の読み込みに失敗しました');
      return false;
    }
  }

  /**
   * 再生・一時停止を切り替える
   */
  async function togglePlayPause() {
    if (!currentFileName) return;

    // 起動直後のスタンバイ状態（Blob未読込）ならロードして再生する
    if (!currentObjectUrl) {
      await loadEpisode(currentFileName, { autoplay: true });
      return;
    }

    if (audioElement.paused || audioElement.ended) {
      await safePlay();
    } else {
      audioElement.pause();
    }
  }

  /**
   * 再生位置を指定秒数へ移動する（シークバー・メモジャンプ用）
   * @param {number} targetSeconds
   */
  function seekTo(targetSeconds) {
    if (!currentFileName) return;

    const duration = getCurrentDuration();
    const clamped =
      duration > 0
        ? Math.max(0, Math.min(duration - 0.1, targetSeconds))
        : Math.max(0, targetSeconds);

    if (!currentObjectUrl) {
      loadEpisode(currentFileName, { autoplay: true, startTime: clamped });
      return;
    }

    if (audioElement.readyState >= 1) {
      audioElement.currentTime = clamped;
    } else {
      pendingSeekTime = clamped;
    }

    persistCurrentPosition({ saveFullMeta: true });
    updateMediaSessionPositionState();
    emitStateChange();
  }

  /**
   * 現在の再生位置から指定秒数だけ前後へスキップする（-15 / +30）
   * @param {number} deltaSeconds
   */
  function seekBy(deltaSeconds) {
    if (!currentFileName) return;
    const base = getCurrentTimeValue();
    seekTo(base + deltaSeconds);
  }

  /**
   * 再生速度を変更し、設定へ保存する
   * @param {number} rate
   */
  function setPlaybackRate(rate) {
    const meta = getMeta();
    const safeRate = typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1.0;
    audioElement.playbackRate = safeRate;
    if (meta) {
      updateSettings(meta, { playbackRate: safeRate });
    }
    updateMediaSessionPositionState();
    emitStateChange();
    return safeRate;
  }

  /**
   * 再生速度を 1.0x -> 1.25x -> 1.5x -> 1.75x -> 2.0x と順送りで切り替える
   */
  function cyclePlaybackRate() {
    const nextRate = getNextPlaybackRate(getSavedPlaybackRate());
    return setPlaybackRate(nextRate);
  }

  /**
   * アプリ起動時用：重いBlobはまだ読まず、ミニプレイヤーに前回のエピソードだけ表示準備する
   * @param {string | null} fileName
   */
  function prepareStandby(fileName) {
    if (!fileName) return;
    const ep = getMeta()?.episodes?.[fileName];
    if (!ep || !ep.hasAudio) return;

    currentFileName = fileName;
    updateMediaSessionMetadata();
    emitStateChange();
  }

  /**
   * エピソード削除時に呼ばれ、再生中／先読み中なら安全に停止・解放する
   * @param {string} fileName
   */
  function handleFileDeleted(fileName) {
    if (preloaded && preloaded.fileName === fileName) {
      clearPreload();
    }
    if (currentFileName === fileName) {
      stopAndUnload();
      clearPlayback();
    }
  }

  /**
   * 番組名やテーマカラー変更時にメタデータと表示を再同期する
   */
  function refreshMetadata() {
    if (!currentFileName) return;
    const ep = getMeta()?.episodes?.[currentFileName];
    if (!ep || !ep.hasAudio) {
      stopAndUnload();
      return;
    }
    updateMediaSessionMetadata();
    emitStateChange();
  }

  /**
   * 再生を停止する（スリープタイマー等から呼び出す用）
   */
  function pause() {
    if (!audioElement.paused) {
      audioElement.pause();
    }
  }

  /**
   * 再生中の時刻更新イベントを購読する（Phase 5 スリープタイマー用）
   */
  function onTimeTick(listener) {
    timeTickListeners.add(listener);
    return () => timeTickListeners.delete(listener);
  }

  // =========================================================================
  // <audio> 要素のイベント監視
  // =========================================================================

  audioElement.addEventListener('loadedmetadata', () => {
    if (!currentFileName) return;
    const meta = getMeta();
    const ep = meta?.episodes?.[currentFileName];

    // 速度を必ず復元（iOSはsrc差し替えで1.0に戻ることがある）
    audioElement.playbackRate = getSavedPlaybackRate();

    // ヘッダ解析で長さが取れなかった場合（MP3等）は、ここで実測長を補完保存する
    const realDuration = audioElement.duration;
    if (
      ep &&
      Number.isFinite(realDuration) &&
      realDuration > 0 &&
      (!ep.duration || Math.abs(ep.duration - realDuration) >= 1)
    ) {
      updateEpisodeProgress(meta, currentFileName, {
        duration: realDuration,
        persist: true,
      });
      callbacks.onMetaUpdated?.();
    }

    if (pendingSeekTime !== null) {
      const maxTime =
        Number.isFinite(realDuration) && realDuration > 0
          ? Math.max(0, realDuration - 0.5)
          : pendingSeekTime;
      audioElement.currentTime = Math.max(0, Math.min(maxTime, pendingSeekTime));
      pendingSeekTime = null;
    }

    updateMediaSessionPositionState();
    emitStateChange();
  });

  audioElement.addEventListener('durationchange', () => {
    if (!currentFileName) return;
    const meta = getMeta();
    const ep = meta?.episodes?.[currentFileName];
    const realDuration = audioElement.duration;

    if (
      ep &&
      Number.isFinite(realDuration) &&
      realDuration > 0 &&
      (!ep.duration || Math.abs(ep.duration - realDuration) >= 1)
    ) {
      updateEpisodeProgress(meta, currentFileName, {
        duration: realDuration,
        persist: true,
      });
      callbacks.onMetaUpdated?.();
    }
    updateMediaSessionPositionState();
    emitStateChange();
  });

  audioElement.addEventListener('play', () => {
    audioElement.playbackRate = getSavedPlaybackRate();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    updateMediaSessionPositionState();
    emitStateChange();
  });

  audioElement.addEventListener('pause', () => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    persistCurrentPosition({ saveFullMeta: true });
    updateMediaSessionPositionState();
    emitStateChange();
  });

  audioElement.addEventListener('seeked', () => {
    persistCurrentPosition({ saveFullMeta: true });
    updateMediaSessionPositionState();
    emitStateChange();
  });

  audioElement.addEventListener('ratechange', () => {
    updateMediaSessionPositionState();
    emitStateChange();
  });

  audioElement.addEventListener('timeupdate', () => {
    if (!currentFileName || !currentObjectUrl) return;
    const meta = getMeta();
    const currentTime = audioElement.currentTime || 0;
    const duration = audioElement.duration;

    // 再生中は3秒ごとに軽量レジューム保存
    if (Date.now() - lastSavedAt >= RESUME_SAVE_INTERVAL_MS) {
      persistCurrentPosition({ saveFullMeta: false });
    }

    // 95%以上再生で自動聴了判定
    const threshold = meta?.settings?.completedThreshold ?? 0.95;
    if (Number.isFinite(duration) && duration > 0 && currentTime / duration >= threshold) {
      if (markEpisodeCompleted(meta, currentFileName)) {
        callbacks.onEpisodeCompleted?.(currentFileName);
        callbacks.onMetaUpdated?.();
      }
    }

    // 残り30秒を切ったら次の未聴エピソードを裏で先読みする
    maybePreloadNext();

    for (const listener of timeTickListeners) {
      listener(getSnapshot());
    }

    emitStateChange();
  });

  audioElement.addEventListener('ended', () => {
    if (!currentFileName) return;
    const meta = getMeta();
    const finishedName = currentFileName;

    // 聴了マーク＆再生位置保存
    const finalTime = Number.isFinite(audioElement.duration)
      ? audioElement.duration
      : audioElement.currentTime;
    updateEpisodeProgress(meta, finishedName, {
      currentTime: finalTime,
      duration: Number.isFinite(audioElement.duration) ? audioElement.duration : undefined,
      persist: false,
    });
    savePlayback(finishedName, finalTime);
    if (markEpisodeCompleted(meta, finishedName)) {
      callbacks.onEpisodeCompleted?.(finishedName);
    }
    callbacks.onMetaUpdated?.();

    // スリープタイマー「この回の終了時」が有効なら連続再生を許可しない
    const allowAutoPlay = callbacks.onBeforeAutoPlayNext
      ? callbacks.onBeforeAutoPlayNext(finishedName) !== false
      : true;

    // 連続再生がONなら次の未聴／途中エピソードへ
    if (allowAutoPlay && meta?.settings?.autoPlayNext) {
      // 1. 先読み済みのObjectURLがあれば、DB待ちゼロ（同期）で即座に切り替える！
      if (preloaded && meta.episodes?.[preloaded.fileName]?.hasAudio) {
        const nextEp = meta.episodes[preloaded.fileName];
        const nextUrl = preloaded.objectUrl;
        const oldUrl = currentObjectUrl;

        preloaded = null;
        currentObjectUrl = nextUrl;
        currentFileName = nextEp.fileName;
        pendingSeekTime = nextEp.currentTime > 0 ? nextEp.currentTime : null;

        audioElement.src = nextUrl;
        audioElement.playbackRate = getSavedPlaybackRate();
        if (oldUrl && oldUrl !== nextUrl) {
          revokeUrl(oldUrl);
        }

        updateMediaSessionMetadata();
        emitStateChange();
        safePlay();
        return;
      }

      // 2. 先読みが間に合わなかった場合は通常の非同期ロードで次へ進む
      const nextEp = findNextPlayableEpisode(meta, finishedName);
      if (nextEp) {
        loadEpisode(nextEp.fileName, { autoplay: true });
        return;
      }
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    emitStateChange();
  });

  audioElement.addEventListener('error', () => {
    if (!currentObjectUrl) return;
    console.error('audio要素で再生エラーが発生しました:', audioElement.error);
    callbacks.onError?.('音声ファイルの再生中にエラーが発生しました');
    emitStateChange();
  });

  // =========================================================================
  // バックグラウンド移行・画面離脱時の即時レジューム保存
  // =========================================================================
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persistCurrentPosition({ saveFullMeta: true });
    }
  });

  window.addEventListener('pagehide', () => {
    persistCurrentPosition({ saveFullMeta: true });
  });

  // =========================================================================
  // iOS Media Session API アクション登録
  // ※あえて previoustrack / nexttrack を登録しないことで、ロック画面に
  //   「15秒戻し / 30秒送り」ボタンが確実に表示されるようにします
  // =========================================================================
  if ('mediaSession' in navigator) {
    const safeRegisterAction = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // 一部アクションに非対応のブラウザでもエラーを出さない
      }
    };

    safeRegisterAction('play', () => {
      togglePlayPause();
    });
    safeRegisterAction('pause', () => {
      pause();
    });
    safeRegisterAction('seekbackward', (details) => {
      const offset = details?.seekOffset || 15;
      seekBy(-offset);
    });
    safeRegisterAction('seekforward', (details) => {
      const offset = details?.seekOffset || 30;
      seekBy(offset);
    });
    safeRegisterAction('seekto', (details) => {
      if (typeof details?.seekTime === 'number') {
        seekTo(details.seekTime);
      }
    });
  }

  return {
    loadEpisode,
    togglePlayPause,
    seekTo,
    seekBy,
    setPlaybackRate,
    cyclePlaybackRate,
    prepareStandby,
    handleFileDeleted,
    refreshMetadata,
    stopAndUnload,
    pause,
    onTimeTick,
    getState: getSnapshot,
  };
}
