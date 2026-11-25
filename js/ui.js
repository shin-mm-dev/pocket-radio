/**
 * Pocket Radio 画面描画モジュール（UI）
 * 役割：データをもとに、番組タブ・エピソード一覧カード・設定画面・
 *       確認ダイアログ・お知らせトーストなどを画面上に描き直します。
 * 注意：セキュリティ（HTML注入防止）のため、動的な文字列はすべて textContent で設定します。
 */

import { formatDuration, formatFileSize } from './parser.js';
import {
  buildProgramTabs,
  getProgramDisplayInfo,
  getTotalAudioStats,
  getUnmappedProgramKeys,
  PROGRAM_COLOR_PRESETS,
  queryAllMemos,
} from './storage.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 画面下部に短時間のお知らせ（トースト）を表示する
 * @param {string} message - 表示したい文章
 * @param {'info'|'success'|'warning'} type - お知らせの種類
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3600);
}

/**
 * 指定したモーダルを開く
 * @param {string} modalId
 */
export function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
}

/**
 * 指定したモーダルを閉じる
 * @param {string} modalId
 */
export function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

/**
 * 確認ダイアログを開き、ユーザーが「実行」か「キャンセル」を選ぶまで待つ
 * @param {{ title: string, message: string, okLabel?: string, isDanger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export function confirmAction({
  title,
  message,
  okLabel = '実行する',
  isDanger = true,
}) {
  const modal = document.getElementById('modal-confirm');
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  const okBtn = document.getElementById('btn-confirm-ok');
  const cancelBtn = document.getElementById('btn-confirm-cancel');
  const backdrop = modal?.querySelector('[data-close-modal="modal-confirm"]');

  if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
    return Promise.resolve(false);
  }

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = okLabel;
  okBtn.className = isDanger ? 'btn-danger' : 'btn-primary-action';

  openModal('modal-confirm');

  return new Promise((resolve) => {
    let settled = false;

    const cleanupAndResolve = (result) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeyDown);
      closeModal('modal-confirm');
      resolve(result);
    };

    const onOk = () => cleanupAndResolve(true);
    const onCancel = () => cleanupAndResolve(false);
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        cleanupAndResolve(false);
      }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeyDown);
  });
}

/**
 * ラジオアイコンのSVG要素を生成する
 */
function createRadioIconSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p1 = document.createElementNS(SVG_NS, 'path');
  p1.setAttribute('d', 'M4.9 19.1C1 15.2 1 8.8 4.9 4.9');
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', '12');
  c.setAttribute('cy', '12');
  c.setAttribute('r', '2');
  const p2 = document.createElementNS(SVG_NS, 'path');
  p2.setAttribute('d', 'M19.1 4.9C23 8.8 23 15.1 19.1 19');

  svg.append(p1, c, p2);
  return svg;
}

/**
 * ゴミ箱アイコンのSVG要素を生成する
 */
function createTrashIconSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '19');
  svg.setAttribute('height', '19');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path1 = document.createElementNS(SVG_NS, 'path');
  path1.setAttribute('d', 'M3 6h18');
  const path2 = document.createElementNS(SVG_NS, 'path');
  path2.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6');
  const path3 = document.createElementNS(SVG_NS, 'path');
  path3.setAttribute('d', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');

  svg.append(path1, path2, path3);
  return svg;
}

/**
 * 番組切り替えタブを描画する
 */
export function renderProgramTabs(tabs, activeTabKey, onSelectTab) {
  const container = document.getElementById('program-tabs');
  if (!container) return;

  const fragment = document.createDocumentFragment();

  for (const tab of tabs) {
    const isActive = tab.key === activeTabKey;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `program-tab${isActive ? ' is-active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.dataset.program = tab.key;
    btn.style.setProperty('--tab-color', tab.color);

    const dot = document.createElement('span');
    dot.className = 'program-tab__dot';

    const label = document.createElement('span');
    label.className = 'program-tab__label';
    label.textContent = tab.isUnmapped ? `${tab.name}（未設定）` : tab.name;

    const count = document.createElement('span');
    count.className = 'program-tab__count';
    count.textContent = String(tab.count);

    btn.append(dot, label, count);
    btn.addEventListener('click', () => onSelectTab(tab.key));
    fragment.appendChild(btn);
  }

  container.innerHTML = '';
  container.appendChild(fragment);
}

/**
 * サマリー・フィルターチップ・並び替えボタンを最新状態に同期する
 */
export function renderToolbar({ selectedTab, filter, sortOrder }) {
  const listSummary = document.getElementById('list-summary');
  if (listSummary && selectedTab) {
    const sizeText = formatFileSize(selectedTab.totalBytes);
    listSummary.textContent = `${selectedTab.count}本（再生可能 ${selectedTab.playableCount}本）・合計 ${sizeText}`;
  }

  document.querySelectorAll('#filter-chips .filter-chip').forEach((chip) => {
    const isActive = chip.getAttribute('data-filter') === filter;
    chip.classList.toggle('is-active', isActive);
  });

  const sortBtn = document.getElementById('btn-toggle-sort');
  if (sortBtn) {
    sortBtn.setAttribute('data-order', sortOrder);
    const labelSpan = sortBtn.querySelector('span:first-child');
    const arrowSpan = sortBtn.querySelector('.sort-btn__arrow');
    if (labelSpan) labelSpan.textContent = sortOrder === 'desc' ? '新しい順' : '古い順';
    if (arrowSpan) arrowSpan.textContent = sortOrder === 'desc' ? '↓' : '↑';
  }
}

/**
 * エピソード一覧カードを描画する
 */
export function renderEpisodeList({
  meta,
  episodes,
  activeProgramTab,
  activeFilter,
  playingFileName = null,
  isPlaying = false,
  handlers,
}) {
  const listEl = document.getElementById('episode-list');
  const emptyStateEl = document.getElementById('empty-state');
  if (!listEl || !emptyStateEl) return;

  const totalEpisodesCount = Object.keys(meta.episodes || {}).length;

  // アプリに1本も登録がないときは初期案内を表示
  if (totalEpisodesCount === 0) {
    listEl.innerHTML = '';
    emptyStateEl.hidden = false;
    return;
  }

  emptyStateEl.hidden = true;

  // 登録はあるが、選択中タブやフィルター条件で0件のとき
  if (episodes.length === 0) {
    const emptyBox = document.createElement('div');
    emptyBox.className = 'filter-empty-state';

    const msg = document.createElement('p');
    msg.className = 'filter-empty-state__text';
    if (activeFilter === 'playable') {
      msg.textContent = '未聴・再生途中のエピソードはありません';
    } else if (activeFilter === 'completed') {
      msg.textContent = '聴了済みのエピソードはまだありません';
    } else {
      msg.textContent = 'この番組のエピソードはありません';
    }
    emptyBox.appendChild(msg);

    if (activeFilter !== 'all') {
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn-secondary';
      resetBtn.textContent = '「すべて」を表示する';
      resetBtn.addEventListener('click', () => handlers.onResetFilter?.());
      emptyBox.appendChild(resetBtn);
    }

    listEl.innerHTML = '';
    listEl.appendChild(emptyBox);
    return;
  }

  // エピソードごとのメモ件数を集計
  const memoCountMap = new Map();
  for (const memo of meta.memos || []) {
    if (!memo || !memo.fileName) continue;
    memoCountMap.set(memo.fileName, (memoCountMap.get(memo.fileName) || 0) + 1);
  }

  const completedHistorySet = new Set(meta.completedHistory || []);
  const fragment = document.createDocumentFragment();

  for (const ep of episodes) {
    const program = getProgramDisplayInfo(meta, ep.programKey);
    const isCurrentlyPlaying = ep.fileName === playingFileName && isPlaying;
    const isSelectedTrack = ep.fileName === playingFileName;
    const memoCount = memoCountMap.get(ep.fileName) || 0;

    const card = document.createElement('article');
    card.className = 'episode-card';
    if (!ep.hasAudio) card.classList.add('is-deleted-audio');
    if (isSelectedTrack) card.classList.add('is-current-track');
    card.style.setProperty('--program-accent', program.color);

    // メインのタップ領域（左アイコン＋中央情報）
    const mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'episode-card__main';
    mainBtn.addEventListener('click', () => handlers.onSelectEpisode?.(ep));

    // 左アイコン枠（再生中は波形アニメーション）
    const iconBox = document.createElement('span');
    iconBox.className = 'episode-card__icon';
    if (isCurrentlyPlaying) {
      const bars = document.createElement('span');
      bars.className = 'eq-bars';
      bars.setAttribute('aria-hidden', 'true');
      bars.append(
        document.createElement('span'),
        document.createElement('span'),
        document.createElement('span')
      );
      iconBox.appendChild(bars);
    } else {
      iconBox.appendChild(createRadioIconSvg());
    }

    // 中央情報エリア
    const body = document.createElement('span');
    body.className = 'episode-card__body';

    // 1行目：「すべて」タブなら番組名ピル＋放送日タイトル
    const titleRow = document.createElement('span');
    titleRow.className = 'episode-card__title-row';

    if (activeProgramTab === 'all') {
      const badge = document.createElement('span');
      badge.className = 'episode-program-pill';
      badge.textContent = program.name;
      titleRow.appendChild(badge);
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'episode-card__title';
    titleEl.textContent = ep.title;
    titleRow.appendChild(titleEl);

    // 2行目：元ファイル名＋メモ件数
    const subRow = document.createElement('span');
    subRow.className = 'episode-card__sub-row';

    const fileEl = document.createElement('span');
    fileEl.className = 'episode-card__filename';
    fileEl.textContent = ep.fileName;
    subRow.appendChild(fileEl);

    body.append(titleRow, subRow);

    // 3行目：4パターンのステータス表示
    const durationKnown = typeof ep.duration === 'number' && Number.isFinite(ep.duration) && ep.duration > 0;
    const durationText = formatDuration(ep.duration);
    const sizeText = formatFileSize(ep.fileSize);

    if (!ep.hasAudio) {
      const statusEl = document.createElement('span');
      statusEl.className = 'episode-card__status is-muted';
      statusEl.textContent =
        ep.status === 'completed'
          ? '✓ 聴了 ・ 音声データ削除済み'
          : '音声データ削除済み';
      body.appendChild(statusEl);
    } else if (ep.status === 'completed') {
      const statusEl = document.createElement('span');
      statusEl.className = 'episode-card__status is-completed';
      statusEl.textContent = durationKnown
        ? `✓ 聴了 (${durationText}) ・ ${sizeText}`
        : `✓ 聴了 ・ ${sizeText}`;
      body.appendChild(statusEl);
    } else if (ep.status === 'playing' || (ep.currentTime && ep.currentTime > 0)) {
      if (durationKnown) {
        const percent = Math.max(0, Math.min(100, (ep.currentTime / ep.duration) * 100));
        const progressTrack = document.createElement('span');
        progressTrack.className = 'card-progress';
        const progressFill = document.createElement('span');
        progressFill.className = 'card-progress__fill';
        progressFill.style.width = `${percent.toFixed(1)}%`;
        progressTrack.appendChild(progressFill);
        body.appendChild(progressTrack);

        const remainingSec = Math.max(0, ep.duration - ep.currentTime);
        const statusEl = document.createElement('span');
        statusEl.className = 'episode-card__status is-playing';
        statusEl.textContent = `続きから再生 (残り ${formatDuration(remainingSec)} / ${durationText})`;
        body.appendChild(statusEl);
      } else {
        const statusEl = document.createElement('span');
        statusEl.className = 'episode-card__status is-playing';
        statusEl.textContent = `続きから再生 (経過 ${formatDuration(ep.currentTime)}) ・ ${sizeText}`;
        body.appendChild(statusEl);
      }
    } else {
      const statusEl = document.createElement('span');
      statusEl.className = 'episode-card__status';
      statusEl.textContent = durationKnown
        ? `未聴 (${durationText}) ・ ${sizeText}`
        : `未聴 ・ ${sizeText}`;
      body.appendChild(statusEl);
    }

    mainBtn.append(iconBox, body);
    card.appendChild(mainBtn);

    // 右端アクション領域（メモバッジ＋ゴミ箱または再取り込み許可）
    const actionsEl = document.createElement('div');
    actionsEl.className = 'episode-card__actions';

    if (memoCount > 0) {
      const memoBtn = document.createElement('button');
      memoBtn.type = 'button';
      memoBtn.className = 'memo-count-badge';
      memoBtn.setAttribute('aria-label', `${memoCount}件のメモを見る`);
      memoBtn.textContent = `📝 ${memoCount}`;
      memoBtn.addEventListener('click', () => handlers.onOpenEpisodeMemos?.(ep));
      actionsEl.appendChild(memoBtn);
    }

    if (ep.hasAudio) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'icon-btn btn-icon-danger';
      deleteBtn.setAttribute('aria-label', `${ep.title}の音声データを削除`);
      deleteBtn.title = '音声データを削除（容量を空ける）';
      deleteBtn.appendChild(createTrashIconSvg());
      deleteBtn.addEventListener('click', () => handlers.onDeleteAudio?.(ep));
      actionsEl.appendChild(deleteBtn);
    } else if (completedHistorySet.has(ep.fileName)) {
      const revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.className = 'btn-text-chip';
      revokeBtn.textContent = '再取込可';
      revokeBtn.title = '聴了記録を取り消して再取り込みを許可する';
      revokeBtn.addEventListener('click', () => handlers.onRevokeCompleted?.(ep.fileName));
      actionsEl.appendChild(revokeBtn);
    }

    card.appendChild(actionsEl);
    fragment.appendChild(card);
  }

  listEl.innerHTML = '';
  listEl.appendChild(fragment);
}

/**
 * ブラウザから取得した容量上限の目安（バイト）を読みやすく整形する
 */
function formatQuotaSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `約 ${gb.toFixed(1)} GB`;
  }
  const mb = Math.round(bytes / (1024 * 1024));
  return `約 ${mb} MB`;
}

/**
 * 設定モーダル内の状態（連続再生・ストレージ・番組マッピング一覧・聴了履歴）を描画する
 */
export function renderSettingsModalContent({
  meta,
  storageEstimate = null,
  historySearch = '',
  handlers,
}) {
  // 1. 連続再生スイッチ
  const autoPlayToggle = document.getElementById('toggle-autoplay-next');
  if (autoPlayToggle) {
    autoPlayToggle.checked = meta.settings?.autoPlayNext !== false;
  }

  // 2. ストレージ使用状況＆一括削除ボタンの件数
  const stats = getTotalAudioStats(meta);
  const storageUsageText = document.getElementById('storage-usage-text');
  if (storageUsageText) {
    const baseText = `保存中の音声: ${stats.playableCount}本（${formatFileSize(stats.totalBytes)}）`;
    const quotaText =
      storageEstimate && storageEstimate.quota > 0
        ? ` ／ ブラウザ上限の目安: ${formatQuotaSize(storageEstimate.quota)}`
        : '';
    storageUsageText.textContent = `${baseText}${quotaText}`;
  }

  const bulkDeleteBtn = document.getElementById('btn-bulk-delete-completed');
  if (bulkDeleteBtn) {
    const deletableCompleted = Object.values(meta.episodes || {}).filter(
      (ep) => ep && ep.hasAudio && ep.status === 'completed'
    );
    const deletableBytes = deletableCompleted.reduce(
      (sum, ep) => sum + (Number(ep.fileSize) || 0),
      0
    );
    if (deletableCompleted.length > 0) {
      bulkDeleteBtn.disabled = false;
      bulkDeleteBtn.textContent = `聴了済みの音声データを一括削除（${deletableCompleted.length}本・${formatFileSize(deletableBytes)}）`;
    } else {
      bulkDeleteBtn.disabled = true;
      bulkDeleteBtn.textContent = '聴了済みの音声データはありません';
    }
  }

  // 3. 未設定の番組キー（ワンタップ設定候補）
  const unmappedBox = document.getElementById('unmapped-program-keys');
  const unmappedKeys = getUnmappedProgramKeys(meta);
  if (unmappedBox) {
    if (unmappedKeys.length === 0) {
      unmappedBox.hidden = true;
      unmappedBox.innerHTML = '';
    } else {
      unmappedBox.hidden = false;
      const frag = document.createDocumentFragment();

      const label = document.createElement('p');
      label.className = 'unmapped-keys__label';
      label.textContent = '未設定の番組キーが見つかりました（タップして名前を設定）';
      frag.appendChild(label);

      const chipsRow = document.createElement('div');
      chipsRow.className = 'unmapped-keys__list';
      for (const key of unmappedKeys) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'unmapped-key-chip';
        chip.textContent = `＋ ${key}`;
        chip.addEventListener('click', () => handlers.onQuickSetupProgram?.(key));
        chipsRow.appendChild(chip);
      }
      frag.appendChild(chipsRow);

      unmappedBox.innerHTML = '';
      unmappedBox.appendChild(frag);
    }
  }

  // 4. 登録済み番組一覧
  const mappingList = document.getElementById('program-mapping-list');
  if (mappingList) {
    const programs = Object.values(meta.programs || {}).sort((a, b) => {
      if (a.key === '_other') return 1;
      if (b.key === '_other') return -1;
      return (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name, 'ja');
    });

    const frag = document.createDocumentFragment();
    for (const prog of programs) {
      const row = document.createElement('div');
      row.className = 'program-mapping-item';

      const left = document.createElement('div');
      left.className = 'program-mapping-item__info';

      const dot = document.createElement('span');
      dot.className = 'program-color-dot';
      dot.style.backgroundColor = prog.color || '#34d399';

      const textBox = document.createElement('div');
      textBox.className = 'program-mapping-item__text';
      const nameEl = document.createElement('strong');
      nameEl.textContent = prog.name;
      const keyEl = document.createElement('small');
      keyEl.textContent = prog.key === '_other' ? '規則外ファイルのまとめ先' : `キー: ${prog.key}`;
      textBox.append(nameEl, keyEl);

      left.append(dot, textBox);

      const actions = document.createElement('div');
      actions.className = 'program-mapping-item__actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-text-chip';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => handlers.onEditProgram?.(prog));
      actions.appendChild(editBtn);

      if (prog.key !== '_other') {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn-text-chip btn-text-chip--danger';
        delBtn.textContent = '削除';
        delBtn.addEventListener('click', () => handlers.onDeleteProgram?.(prog));
        actions.appendChild(delBtn);
      }

      row.append(left, actions);
      frag.appendChild(row);
    }

    mappingList.innerHTML = '';
    mappingList.appendChild(frag);
  }

  // 5. 聴了済み履歴リスト（検索フィルター対応）
  const historyList = document.getElementById('completed-history-list');
  const historySearchInput = document.getElementById('history-search-input');
  const allHistory = [...(meta.completedHistory || [])].reverse();

  if (historySearchInput) {
    historySearchInput.hidden = allHistory.length === 0;
  }

  if (historyList) {
    const keyword = String(historySearch || '').trim().toLowerCase();
    const filteredHistory = keyword
      ? allHistory.filter((name) => name.toLowerCase().includes(keyword))
      : allHistory;

    if (allHistory.length === 0) {
      historyList.innerHTML = '<p class="muted-text">聴了済みのエピソードはまだありません</p>';
    } else if (filteredHistory.length === 0) {
      historyList.innerHTML = '<p class="muted-text">条件に一致する履歴はありません</p>';
    } else {
      const frag = document.createDocumentFragment();
      for (const fileName of filteredHistory) {
        const item = document.createElement('div');
        item.className = 'history-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'history-item__name';
        nameSpan.textContent = fileName;

        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'btn-text-chip';
        revokeBtn.textContent = '取り消す';
        revokeBtn.addEventListener('click', () => handlers.onRevokeCompleted?.(fileName));

        item.append(nameSpan, revokeBtn);
        frag.appendChild(item);
      }
      historyList.innerHTML = '';
      historyList.appendChild(frag);
    }
  }
}

/**
 * 番組フォーム用のカラープリセット8色ボタンを初期化し、カラーピッカーと連動させる
 */
export function setupProgramColorPresets() {
  const presetsContainer = document.getElementById('program-color-presets');
  const colorInput = document.getElementById('program-color-input');
  if (!presetsContainer || !colorInput) return;

  const syncSelection = (selectedColor) => {
    const target = String(selectedColor || '').toLowerCase();
    presetsContainer.querySelectorAll('.color-swatch').forEach((btn) => {
      btn.classList.toggle('is-selected', btn.dataset.color?.toLowerCase() === target);
    });
  };

  const frag = document.createDocumentFragment();
  for (const hex of PROGRAM_COLOR_PRESETS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.dataset.color = hex;
    swatch.style.backgroundColor = hex;
    swatch.setAttribute('aria-label', `カラー ${hex} を選択`);
    swatch.addEventListener('click', () => {
      colorInput.value = hex;
      syncSelection(hex);
    });
    frag.appendChild(swatch);
  }

  presetsContainer.innerHTML = '';
  presetsContainer.appendChild(frag);

  colorInput.addEventListener('input', () => {
    syncSelection(colorInput.value);
  });

  syncSelection(colorInput.value);
}

/**
 * 再生／一時停止ボタンのアイコン（三角 / 二本線）を切り替える
 * @param {HTMLElement | null} buttonEl
 * @param {boolean} isPlaying
 * @param {number} size
 */
function setPlayButtonIcon(buttonEl, isPlaying, size = 22) {
  if (!buttonEl) return;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  if (isPlaying) {
    const r1 = document.createElementNS(SVG_NS, 'rect');
    r1.setAttribute('x', '6');
    r1.setAttribute('y', '4');
    r1.setAttribute('width', '4');
    r1.setAttribute('height', '16');
    r1.setAttribute('rx', '1');

    const r2 = document.createElementNS(SVG_NS, 'rect');
    r2.setAttribute('x', '14');
    r2.setAttribute('y', '4');
    r2.setAttribute('width', '4');
    r2.setAttribute('height', '16');
    r2.setAttribute('rx', '1');

    svg.append(r1, r2);
    buttonEl.setAttribute('aria-label', '一時停止');
  } else {
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('points', '7,4 20,12 7,20');
    svg.append(poly);
    buttonEl.setAttribute('aria-label', '再生');
  }

  buttonEl.innerHTML = '';
  buttonEl.appendChild(svg);
}

/**
 * フルプレイヤー（ボトムシート）を開く
 */
export function openFullPlayer() {
  const sheet = document.getElementById('full-player-sheet');
  if (!sheet) return;
  sheet.hidden = false;
  sheet.setAttribute('aria-hidden', 'false');
}

/**
 * フルプレイヤー（ボトムシート）を閉じる
 */
export function closeFullPlayer() {
  const sheet = document.getElementById('full-player-sheet');
  if (!sheet) return;
  sheet.hidden = true;
  sheet.setAttribute('aria-hidden', 'true');
}

/**
 * ミニプレイヤーおよびフルプレイヤーの画面表示を最新の再生状態で更新する
 */
export function renderPlayerUI({ meta, snapshot, isSeeking = false }) {
  const miniPlayer = document.getElementById('mini-player');
  const fullSheet = document.getElementById('full-player-sheet');
  const headerDot = document.getElementById('header-status-dot');

  const ep = snapshot?.fileName ? meta?.episodes?.[snapshot.fileName] : null;
  if (!ep || !ep.hasAudio) {
    if (miniPlayer) miniPlayer.hidden = true;
    closeFullPlayer();
    if (headerDot) {
      headerDot.style.removeProperty('background');
      headerDot.style.removeProperty('box-shadow');
    }
    return;
  }

  const program = getProgramDisplayInfo(meta, ep.programKey);
  const duration = snapshot.duration > 0 ? snapshot.duration : ep.duration || 0;
  const currentTime = Math.max(0, snapshot.currentTime || 0);
  const percent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  // 番組カラーをプレイヤーとヘッダードットへ反映
  miniPlayer?.style.setProperty('--program-accent', program.color);
  fullSheet?.style.setProperty('--program-accent', program.color);
  if (headerDot) {
    headerDot.style.background = program.color;
    headerDot.style.boxShadow = `0 0 10px ${program.color}`;
  }

  if (miniPlayer) {
    miniPlayer.hidden = false;
  }

  // ミニプレイヤーの各要素を更新
  const miniProgram = document.getElementById('mini-program');
  const miniTitle = document.getElementById('mini-title');
  const miniTime = document.getElementById('mini-time');
  const miniFill = document.getElementById('mini-progress-fill');
  const miniPlayBtn = document.getElementById('btn-mini-play');

  if (miniProgram) miniProgram.textContent = program.name;
  if (miniTitle) miniTitle.textContent = ep.title;
  if (miniTime) miniTime.textContent = `${formatDuration(currentTime)} / ${formatDuration(duration || null)}`;
  if (miniFill) miniFill.style.width = `${percent.toFixed(1)}%`;
  setPlayButtonIcon(miniPlayBtn, snapshot.isPlaying, 20);

  // フルプレイヤーの各要素を更新
  const fullBadge = document.getElementById('full-program-badge');
  const fullTitle = document.getElementById('full-title');
  const fullFilename = document.getElementById('full-filename');
  const fullPlayBtn = document.getElementById('btn-full-play');
  const rateBtn = document.getElementById('btn-playback-rate');
  const completeBtn = document.getElementById('btn-toggle-complete');

  if (fullBadge) {
    fullBadge.textContent = program.name;
    fullBadge.style.color = program.color;
  }
  if (fullTitle) fullTitle.textContent = ep.title;
  if (fullFilename) fullFilename.textContent = ep.fileName;
  setPlayButtonIcon(fullPlayBtn, snapshot.isPlaying, 30);

  if (rateBtn) {
    const rate = snapshot.playbackRate || 1.0;
    rateBtn.textContent = `${Number(rate.toFixed(2))}x`;
  }

  if (completeBtn) {
    completeBtn.textContent = ep.status === 'completed' ? '未聴に戻す' : '聴了にする';
  }

  // シークバーをユーザーがつまんで動かしている間は位置の上書きを止める
  if (!isSeeking) {
    const seekBar = document.getElementById('full-seek-bar');
    const curEl = document.getElementById('full-current-time');
    const remEl = document.getElementById('full-remaining-time');

    if (seekBar) {
      seekBar.max = duration > 0 ? String(duration) : '100';
      seekBar.value = duration > 0 ? String(Math.min(duration, currentTime)) : '0';
      seekBar.disabled = duration <= 0;
    }
    if (curEl) {
      curEl.textContent = formatDuration(currentTime);
    }
    if (remEl) {
      if (duration > 0) {
        const remaining = Math.max(0, duration - currentTime);
        remEl.textContent = `-${formatDuration(remaining)} / ${formatDuration(duration)}`;
      } else {
        remEl.textContent = `--:-- / --:--`;
      }
    }
  }
}

/**
 * スリープタイマーの表示（ボタン文字・モーダル内の選択状態）を更新する
 * @param {{ mode: 'off'|'minutes'|'episode-end', minutes?: number | null, endTimestamp?: number | null }} sleepState
 */
export function renderSleepTimerUI(sleepState) {
  const btn = document.getElementById('btn-sleep-timer');
  const activeOption =
    sleepState.mode === 'minutes'
      ? String(sleepState.minutes)
      : sleepState.mode;

  if (btn) {
    if (sleepState.mode === 'off') {
      btn.textContent = 'タイマー OFF';
      btn.classList.remove('tool-pill--active');
    } else if (sleepState.mode === 'episode-end') {
      btn.textContent = '🌙 終了時停止';
      btn.classList.add('tool-pill--active');
    } else if (sleepState.mode === 'minutes' && sleepState.endTimestamp) {
      const remainingSec = Math.max(0, Math.ceil((sleepState.endTimestamp - Date.now()) / 1000));
      if (remainingSec >= 60) {
        const mins = Math.ceil(remainingSec / 60);
        btn.textContent = `🌙 残り ${mins}分`;
      } else {
        btn.textContent = `🌙 残り ${remainingSec}秒`;
      }
      btn.classList.add('tool-pill--active');
    }
  }

  document.querySelectorAll('#modal-sleep-timer [data-sleep-option]').forEach((optionBtn) => {
    const isMatch = optionBtn.getAttribute('data-sleep-option') === activeOption;
    optionBtn.classList.toggle('is-active', isMatch);
  });
}

/**
 * フルプレイヤー下部の「この回のメモ」一覧を描画する
 */
export function renderEpisodeMemos({ memos, handlers }) {
  const container = document.getElementById('full-episode-memos');
  if (!container) return;

  if (!Array.isArray(memos) || memos.length === 0) {
    container.innerHTML =
      '<p class="muted-text">まだメモはありません（「＋ メモ」から気になった瞬間を残せます）</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const memo of memos) {
    const row = document.createElement('div');
    row.className = 'memo-item';

    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'memo-jump-btn';
    jumpBtn.setAttribute('aria-label', `${formatDuration(memo.timestampSec)} から再生`);
    jumpBtn.addEventListener('click', () => handlers.onJumpMemo?.(memo));

    const timeChip = document.createElement('span');
    timeChip.className = 'memo-timestamp-chip';
    timeChip.textContent = `▶ ${formatDuration(memo.timestampSec)}`;

    const textEl = document.createElement('span');
    textEl.className = 'memo-text';
    textEl.textContent = memo.text;

    jumpBtn.append(timeChip, textEl);

    const actions = document.createElement('div');
    actions.className = 'memo-item__actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-text-chip';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => handlers.onEditMemo?.(memo));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-text-chip btn-text-chip--danger';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', () => handlers.onDeleteMemo?.(memo));

    actions.append(editBtn, delBtn);
    row.append(jumpBtn, actions);
    frag.appendChild(row);
  }

  container.innerHTML = '';
  container.appendChild(frag);
}

/**
 * 「全メモ一覧」モーダル内の番組フィルターとメモカード一覧を描画する
 */
export function renderAllMemosModal({ meta, search = '', programKey = 'all', handlers }) {
  const selectEl = document.getElementById('memo-program-filter');
  const listEl = document.getElementById('all-memos-list');
  if (!listEl) return;

  // 番組フィルターの選択肢を最新の番組データと同期する
  if (selectEl) {
    const tabs = buildProgramTabs(meta).filter((t) => t.key !== 'all');
    const optionFrag = document.createDocumentFragment();

    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'すべての番組';
    optionFrag.appendChild(allOpt);

    for (const tab of tabs) {
      const opt = document.createElement('option');
      opt.value = tab.key;
      opt.textContent = tab.name;
      optionFrag.appendChild(opt);
    }

    selectEl.innerHTML = '';
    selectEl.appendChild(optionFrag);
    const hasSelectedOption = Array.from(selectEl.options).some((o) => o.value === programKey);
    selectEl.value = hasSelectedOption ? programKey : 'all';
  }

  const effectiveProgramKey = selectEl ? selectEl.value : programKey;
  const results = queryAllMemos(meta, { search, programKey: effectiveProgramKey });

  if (results.length === 0) {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'muted-text';
    emptyMsg.textContent =
      (meta.memos || []).length === 0
        ? '保存されたメモはまだありません'
        : '条件に一致するメモが見つかりません';
    listEl.innerHTML = '';
    listEl.appendChild(emptyMsg);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const { memo, episode, program } of results) {
    const card = document.createElement('article');
    card.className = 'memo-card';
    card.style.setProperty('--program-accent', program.color);

    const header = document.createElement('div');
    header.className = 'memo-card__header';

    const metaBox = document.createElement('div');
    metaBox.className = 'memo-card__meta';

    const pill = document.createElement('span');
    pill.className = 'episode-program-pill';
    pill.textContent = program.name;

    const epTitle = document.createElement('span');
    epTitle.className = 'memo-card__episode';
    epTitle.textContent = episode?.title || memo.fileName;

    metaBox.append(pill, epTitle);

    if (!episode || !episode.hasAudio) {
      const noAudio = document.createElement('span');
      noAudio.className = 'memo-card__noaudio';
      noAudio.textContent = '(音声削除済み)';
      metaBox.appendChild(noAudio);
    }

    header.appendChild(metaBox);

    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'memo-jump-btn';
    jumpBtn.addEventListener('click', () => handlers.onJumpMemo?.(memo, episode));

    const timeChip = document.createElement('span');
    timeChip.className = 'memo-timestamp-chip';
    timeChip.textContent = `▶ ${formatDuration(memo.timestampSec)}`;

    const textEl = document.createElement('span');
    textEl.className = 'memo-text';
    textEl.textContent = memo.text;

    jumpBtn.append(timeChip, textEl);

    const footer = document.createElement('div');
    footer.className = 'memo-card__footer';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-text-chip';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => handlers.onEditMemo?.(memo));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-text-chip btn-text-chip--danger';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', () => handlers.onDeleteMemo?.(memo));

    footer.append(editBtn, delBtn);
    card.append(header, jumpBtn, footer);
    frag.appendChild(card);
  }

  listEl.innerHTML = '';
  listEl.appendChild(frag);
}

/**
 * バックアップJSONの復元方法（「現在のデータと統合」か「上書き」）をユーザーに選んでもらう
 * @param {{ programCount: number, episodeCount: number, memoCount: number, historyCount: number }} summary
 * @returns {Promise<'merge' | 'replace' | 'cancel'>}
 */
export function chooseBackupImportMode(summary) {
  const modal = document.getElementById('modal-backup-import');
  const summaryEl = document.getElementById('backup-import-summary');
  const mergeBtn = document.getElementById('btn-import-merge');
  const replaceBtn = document.getElementById('btn-import-replace');
  const cancelBtn = document.getElementById('btn-import-cancel');
  const closeBtn = document.getElementById('btn-import-close');
  const backdrop = modal?.querySelector('[data-close-modal="modal-backup-import"]');

  if (!modal || !summaryEl || !mergeBtn || !replaceBtn || !cancelBtn) {
    return Promise.resolve('cancel');
  }

  summaryEl.textContent =
    `読み込み内容：番組設定 ${summary.programCount}件 / 再生記録 ${summary.episodeCount}件 / メモ ${summary.memoCount}件 / 聴了履歴 ${summary.historyCount}件`;

  openModal('modal-backup-import');

  return new Promise((resolve) => {
    let settled = false;

    const cleanupAndResolve = (mode) => {
      if (settled) return;
      settled = true;
      mergeBtn.removeEventListener('click', onMerge);
      replaceBtn.removeEventListener('click', onReplace);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn?.removeEventListener('click', onCancel);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeyDown);
      closeModal('modal-backup-import');
      resolve(mode);
    };

    const onMerge = () => cleanupAndResolve('merge');
    const onReplace = () => cleanupAndResolve('replace');
    const onCancel = () => cleanupAndResolve('cancel');
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        cleanupAndResolve('cancel');
      }
    };

    mergeBtn.addEventListener('click', onMerge);
    replaceBtn.addEventListener('click', onReplace);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn?.addEventListener('click', onCancel);
    backdrop?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeyDown);
  });
}
