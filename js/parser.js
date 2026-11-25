/**
 * Pocket Radio 解析モジュール（ファイル名解析・音声形式判定・再生時間パーサー）
 * 役割：
 *  1. ファイル名（例: Harusanchi-2026-11-23.aac）から番組キー・放送日・曜日を読み取る
 *  2. 音声データの先頭バイトを見て、正しい音声形式（MIMEタイプ）を判定する
 *  3. <audio>要素を大量に作らず、ファイルの中身のヘッダ情報だけから再生時間を高速計算する
 */

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

// フォールバック選択（「すべてのファイル形式」）で受け付ける拡張子
const SUPPORTED_EXTENSIONS = new Set([
  'aac',
  'm4a',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'opus',
  'flac',
]);

// ADTSヘッダが示すサンプリング周波数テーブル（Hz）
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

// 拡張子ごとの標準MIMEタイプ
const EXTENSION_MIME_MAP = {
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
};

/**
 * ファイル名から拡張子（小文字）を取り出す
 * @param {string} fileName
 */
export function getFileExtension(fileName) {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return '';
  }
  return fileName.slice(dotIndex + 1).toLowerCase();
}

/**
 * ファイル名から拡張子を除いた名前を取り出す
 * @param {string} fileName
 */
function stripExtension(fileName) {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) return fileName;
  return fileName.slice(0, dotIndex);
}

/**
 * ファイル名から「番組キー」「放送日」「曜日」「表示タイトル」を解析する
 * 規則に合致しない場合でもエラーにせず「その他(_other)」として安全に返す
 * @param {string} fileName
 * @param {Record<string, { key: string }>} existingPrograms
 */
export function parseFileName(fileName, existingPrograms = {}) {
  const baseName = stripExtension(fileName).trim();

  // 基本形式: [番組キー]-[YYYY-MM-DD].aac（iCloud重複時の "(1)" サフィックスも許容）
  const match = fileName.match(/^(.+?)[-_](\d{4})[-_]?(\d{2})[-_]?(\d{2})(?:\s*\(\d+\))?\.[^.]+$/i);
  if (!match) {
    return {
      programKey: '_other',
      broadcastDate: null,
      dayOfWeek: null,
      title: baseName || fileName,
      isStructured: false,
    };
  }

  const rawKey = match[1].trim();
  const year = Number.parseInt(match[2], 10);
  const month = Number.parseInt(match[3], 10);
  const day = Number.parseInt(match[4], 10);

  // タイムゾーンで1日ズレるのを防ぐため、ローカル日付で生成し実在日付か検証する
  const date = new Date(year, month - 1, day);
  const isValidDate =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;

  if (!rawKey || !isValidDate) {
    return {
      programKey: '_other',
      broadcastDate: null,
      dayOfWeek: null,
      title: baseName || fileName,
      isStructured: false,
    };
  }

  // 登録済み番組キーと大文字・小文字を無視して照合し、一致すれば登録キーに寄せる
  let normalizedKey = rawKey;
  const lowerRawKey = rawKey.toLowerCase();
  for (const registeredKey of Object.keys(existingPrograms)) {
    if (registeredKey !== '_other' && registeredKey.toLowerCase() === lowerRawKey) {
      normalizedKey = registeredKey;
      break;
    }
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const broadcastDate = `${year}-${mm}-${dd}`;
  const dayOfWeek = WEEKDAYS_JA[date.getDay()];

  return {
    programKey: normalizedKey,
    broadcastDate,
    dayOfWeek,
    title: `${broadcastDate} (${dayOfWeek}) 放送`,
    isStructured: true,
  };
}

/**
 * 音声ファイルの先頭に付いている ID3v2 タグ（曲情報ヘッダ）のバイト長をスキップする
 * @param {Uint8Array} bytes
 * @returns {number} タグが終わる位置のオフセット（なければ0）
 */
export function skipId3v2Tag(bytes) {
  if (bytes.length < 10) return 0;
  // 先頭が "ID3" (0x49, 0x44, 0x33) か確認
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return 0;
  }

  // ID3v2サイズは各バイト上位1bitを除いた7bit×4で記録されている
  const tagSize =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);

  const hasFooter = (bytes[5] & 0x10) !== 0;
  const totalOffset = 10 + tagSize + (hasFooter ? 10 : 0);

  return totalOffset <= bytes.length ? totalOffset : 0;
}

/**
 * バイト列の特定位置からASCII文字列を読み取る
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} length
 */
function readAscii(bytes, start, length) {
  if (start + length > bytes.length) return '';
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(bytes[start + i]);
  }
  return text;
}

/**
 * ADTS（生AAC）の同期ワードかどうかを判定する
 */
function isAdtsSync(bytes, offset) {
  return (
    offset + 7 <= bytes.length &&
    bytes[offset] === 0xff &&
    (bytes[offset + 1] & 0xf6) === 0xf0
  );
}

/**
 * 音声バイナリの先頭と拡張子から、正確な形式と MIME タイプを判定する
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} fileName
 * @param {string} originalMime
 */
export function detectAudioFormat(arrayBuffer, fileName = '', originalMime = '') {
  const bytes = new Uint8Array(arrayBuffer);
  const ext = getFileExtension(fileName);

  // 1. M4A / MP4 コンテナ（4〜8バイト目に "ftyp" がある）
  if (bytes.length >= 12 && readAscii(bytes, 4, 4) === 'ftyp') {
    return { format: 'mp4', mimeType: 'audio/mp4', isAudio: true, dataOffset: 0 };
  }

  // 2. 生のAAC（ADTS形式：先頭またはID3タグ直後に 0xFF 0xF1 / 0xFF 0xF9）
  const id3Offset = skipId3v2Tag(bytes);
  if (isAdtsSync(bytes, id3Offset)) {
    return { format: 'adts', mimeType: 'audio/aac', isAudio: true, dataOffset: id3Offset };
  }

  // 3. WAV（RIFF ... WAVE）
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WAVE') {
    return { format: 'wav', mimeType: 'audio/wav', isAudio: true, dataOffset: 0 };
  }

  // 4. Ogg（OggS）
  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === 'OggS') {
    return { format: 'ogg', mimeType: 'audio/ogg', isAudio: true, dataOffset: 0 };
  }

  // 5. FLAC（fLaC）
  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === 'fLaC') {
    return { format: 'flac', mimeType: 'audio/flac', isAudio: true, dataOffset: 0 };
  }

  // 6. MP3（ID3タグ付き、またはMP3フレーム同期）
  const isMp3Sync =
    id3Offset + 2 <= bytes.length &&
    bytes[id3Offset] === 0xff &&
    (bytes[id3Offset + 1] & 0xe0) === 0xe0 &&
    (bytes[id3Offset + 1] & 0x06) !== 0;

  if (isMp3Sync || (id3Offset > 0 && ext === 'mp3')) {
    return { format: 'mp3', mimeType: 'audio/mpeg', isAudio: true, dataOffset: id3Offset };
  }

  // 7. 先頭バイトで判定しきれなかった場合でも、対応拡張子またはaudio/*なら受け入れる
  if (SUPPORTED_EXTENSIONS.has(ext) || (originalMime && originalMime.startsWith('audio/'))) {
    const fallbackMime = EXTENSION_MIME_MAP[ext] || originalMime || 'audio/aac';
    return {
      format: ext || 'audio',
      mimeType: fallbackMime,
      isAudio: true,
      dataOffset: 0,
    };
  }

  return {
    format: 'unknown',
    mimeType: originalMime || 'application/octet-stream',
    isAudio: false,
    dataOffset: 0,
  };
}

/**
 * 生AAC（ADTS形式）のフレームヘッダだけを順番に数えて再生時間（秒）を計算する
 * 音声のデコード（音への展開）を行わないため、数十MBでも高速・省メモリで動く
 * @param {Uint8Array} bytes
 * @param {number} startOffset
 * @returns {number | null}
 */
export function parseAdtsDuration(bytes, startOffset = 0) {
  let offset = startOffset;
  let totalDuration = 0;
  let frameCount = 0;

  while (offset + 7 <= bytes.length) {
    // 同期ワードがずれていれば、最大64バイト先まで再探索する
    if (!isAdtsSync(bytes, offset)) {
      let resynced = false;
      const searchLimit = Math.min(bytes.length - 7, offset + 64);
      for (let probe = offset + 1; probe <= searchLimit; probe += 1) {
        if (isAdtsSync(bytes, probe)) {
          offset = probe;
          resynced = true;
          break;
        }
      }
      if (!resynced) {
        break;
      }
    }

    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x0f;
    const sampleRate = ADTS_SAMPLE_RATES[sampleRateIndex];
    if (!sampleRate) {
      break;
    }

    // 13bitのフレーム長（ヘッダ7または9バイト＋音声データ本体）
    const frameLength =
      ((bytes[offset + 3] & 0x03) << 11) |
      (bytes[offset + 4] << 3) |
      ((bytes[offset + 5] & 0xe0) >> 5);

    if (frameLength < 7 || offset + frameLength > bytes.length) {
      break;
    }

    // 1フレームに含まれるAACデータブロック数（通常は1ブロック＝1024サンプル）
    const rawDataBlocks = (bytes[offset + 6] & 0x03) + 1;
    totalDuration += (1024 * rawDataBlocks) / sampleRate;
    frameCount += 1;
    offset += frameLength;
  }

  if (frameCount === 0 || !Number.isFinite(totalDuration) || totalDuration <= 0) {
    return null;
  }

  return Math.round(totalDuration * 100) / 100;
}

/**
 * MP4/M4A ボックス（箱）のヘッダ情報を1つ読み取る
 */
function readMp4BoxHeader(view, offset, limit) {
  if (offset + 8 > limit) return null;

  const size32 = view.getUint32(offset);
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7)
  );

  let boxSize = size32;
  let headerSize = 8;

  if (size32 === 1) {
    // 64bit拡張サイズ
    if (offset + 16 > limit) return null;
    const high = view.getUint32(offset + 8);
    const low = view.getUint32(offset + 12);
    boxSize = high * 4294967296 + low;
    headerSize = 16;
  } else if (size32 === 0) {
    // ファイルまたは親ボックスの終端まで
    boxSize = limit - offset;
  }

  if (boxSize < headerSize || offset + boxSize > limit) {
    return null;
  }

  return {
    type,
    dataOffset: offset + headerSize,
    boxEnd: offset + boxSize,
  };
}

/**
 * M4A / MP4 ファイルの moov -> mvhd ヘッダから再生時間（秒）を取得する
 * @param {ArrayBuffer} arrayBuffer
 * @returns {number | null}
 */
export function parseMp4Duration(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const totalLength = arrayBuffer.byteLength;

  let offset = 0;
  while (offset + 8 <= totalLength) {
    const box = readMp4BoxHeader(view, offset, totalLength);
    if (!box) break;

    if (box.type === 'moov') {
      let childOffset = box.dataOffset;
      while (childOffset + 8 <= box.boxEnd) {
        const child = readMp4BoxHeader(view, childOffset, box.boxEnd);
        if (!child) break;

        if (child.type === 'mvhd') {
          const dataOffset = child.dataOffset;
          if (dataOffset + 20 > child.boxEnd) return null;

          const version = view.getUint8(dataOffset);
          let timescale = 0;
          let duration = 0;

          if (version === 0) {
            timescale = view.getUint32(dataOffset + 12);
            duration = view.getUint32(dataOffset + 16);
          } else if (version === 1) {
            if (dataOffset + 32 > child.boxEnd) return null;
            timescale = view.getUint32(dataOffset + 20);
            const durHigh = view.getUint32(dataOffset + 24);
            const durLow = view.getUint32(dataOffset + 28);
            duration = durHigh * 4294967296 + durLow;
          }

          if (timescale > 0 && duration > 0) {
            return Math.round((duration / timescale) * 100) / 100;
          }
          return null;
        }

        childOffset = child.boxEnd;
      }
      return null;
    }

    offset = box.boxEnd;
  }

  return null;
}

/**
 * 音声バイナリから再生時間（秒）を高速取得する
 * 未対応形式の場合は null を返し、初回再生時に <audio> 要素から補完する
 * @param {ArrayBuffer} arrayBuffer
 * @param {{ format: string, dataOffset: number }} detectedFormat
 * @returns {number | null}
 */
export function extractAudioDuration(arrayBuffer, detectedFormat) {
  try {
    if (detectedFormat.format === 'adts') {
      return parseAdtsDuration(new Uint8Array(arrayBuffer), detectedFormat.dataOffset || 0);
    }
    if (detectedFormat.format === 'mp4') {
      return parseMp4Duration(arrayBuffer);
    }
  } catch (error) {
    console.warn('再生時間の高速解析をスキップしました:', error);
  }
  return null;
}

/**
 * 秒数を「39:00」や「1:05:12」のような読みやすい文字列に整形する
 * @param {number | null | undefined} seconds
 */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }
  const totalSec = Math.floor(seconds);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * バイト数を「11.1 MB」や「420 KB」のような読みやすい単位に整形する
 * @param {number} bytes
 */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '0.0 MB';
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 0.1) {
    return `${mb.toFixed(1)} MB`;
  }
  const kb = Math.max(1, Math.round(bytes / 1024));
  return `${kb} KB`;
}
