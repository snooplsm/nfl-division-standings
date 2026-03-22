const FPS = 30;
const DEFAULT_VIDEO_URL = '/videos/alex.mp4';
const DRAFT_DB_NAME = 'retardOverlayTool';
const DRAFT_STORE_NAME = 'drafts';
const DRAFT_KEY = 'current';
const EMPTY_TIMECODE = '00:00:00';
const MAX_OVERLAY_PERCENT = 500;
const VIDEO_BG_MAX_SIDE = 640;
const VIDEO_BG_TARGET_FRAMES = 90;
const VIDEO_BG_MAX_FRAMES = 120;
const VIDEO_BG_MIN_FPS = 3;
const VIDEO_BG_MAX_FPS = 8;
const VIDEO_BG_MODEL = 'isnet_quint8';
const VIDEO_BG_ENCODE_CHUNK_SIZE = 30;

const DEFAULT_SEGMENTS = [
  { name: 'patriot', start: '00:00:00', end: '00:00:23' },
  { name: 'patriot', start: '00:02:00', end: '00:03:00' },
  { name: 'vampire', start: '00:03:02', end: '00:04:04' },
  { name: 'nationalist', start: '00:04:04', end: '00:04:27' },
  { name: 'mental retard', start: '00:05:15', end: '00:07:13' },
  { name: 'ugenacist', start: '00:07:14', end: '00:09:14' },
  { name: 'scared man', start: '00:09:14', end: '00:12:03' },
  { name: 'retard', start: '00:12:13', end: '00:14:17' },
  { name: 'retard', start: '00:14:18', end: '00:16:10' },
  { name: 'traitor', start: '00:16:13', end: '00:18:05' },
  { name: 'vampire', start: '00:18:07', end: '00:21:08' },
  { name: 'vampire', start: '00:21:09', end: '00:22:19' },
  { name: 'vampire', start: '00:22:20', end: '00:24:00' },
  { name: 'vampire', start: '00:24:00', end: '00:25:00' },
  { name: 'next level', start: '00:26:16', end: '00:28:13' },
  { name: 'moses', start: '00:28:14', end: '00:29:29' }
];

const state = {
  videoUrl: DEFAULT_VIDEO_URL,
  videoBinary: null,
  videoObjectUrl: '',
  videoMeta: { width: 0, height: 0 },
  transitionMode: 'cut',
  crossfadeSec: 0.2,
  segments: DEFAULT_SEGMENTS.map((seg, idx) => ({
    id: `seg_${idx}`,
    ...seg,
    x: 50,
    y: 90,
    width: 100,
    height: 100,
    imageBinary: null,
    imageObjectUrl: '',
    imageUrl: ''
  })),
  worker: null,
  bgRemoveDevice: 'idle',
  segmentPreviewId: '',
  segmentPreviewStartSec: null,
  segmentPreviewEndSec: null
};
let draftSaveTimer = null;
let segmentCounter = DEFAULT_SEGMENTS.length;
let removeBackgroundFnPromise = null;

function hasSegmentMedia(seg) {
  return !!(seg.imageBinary || seg.imageUrl);
}

function findNextAvailableSegmentIndex() {
  return state.segments.findIndex((seg) => !hasSegmentMedia(seg));
}

function guessMediaKindFromUrl(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.startsWith('data:video/')) return 'video';
  if (lower.startsWith('data:image/')) return 'image';
  if (/\b(video|mp4|webm|mov|m4v|ogg)\b/.test(lower)) return 'video';
  if (/\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/.test(lower)) return 'video';
  return 'image';
}

function getSegmentMediaKind(seg) {
  const mime = String(seg?.imageBinary?.type || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (seg?.imageUrl) return guessMediaKindFromUrl(seg.imageUrl);
  return 'image';
}

function assignImageBlobToSegment(seg, blob, name = 'pasted.png', type = 'image/png') {
  if (!seg || !blob) return;
  if (seg.imageObjectUrl) {
    revokeObjectUrl(seg.imageObjectUrl);
    seg.imageObjectUrl = '';
  }
  seg.imageBinary = { blob, name, type };
  seg.imageUrl = '';
}

function assignMediaUrlToSegment(seg, url) {
  if (!seg) return;
  if (seg.imageObjectUrl) {
    revokeObjectUrl(seg.imageObjectUrl);
    seg.imageObjectUrl = '';
  }
  seg.imageBinary = null;
  seg.imageUrl = String(url || '').trim();
}

function clearSegmentMedia(seg) {
  if (!seg) return;
  if (seg.imageObjectUrl) {
    revokeObjectUrl(seg.imageObjectUrl);
    seg.imageObjectUrl = '';
  }
  seg.imageBinary = null;
  seg.imageUrl = '';
}

function resolvePasteTarget(eventTarget) {
  if (!(eventTarget instanceof HTMLElement)) return null;
  const row = eventTarget.closest('tr');
  if (!(row instanceof HTMLTableRowElement)) return null;
  const rowId = String(row.dataset.id || '');
  if (!rowId) return null;
  return state.segments.find((seg) => seg.id === rowId) || null;
}

async function getRemoveBackgroundFn() {
  if (!removeBackgroundFnPromise) {
    removeBackgroundFnPromise = import('@imgly/background-removal')
      .then((mod) => mod.removeBackground || mod.default)
      .then((fn) => {
        if (typeof fn !== 'function') {
          throw new Error('removeBackground API not found');
        }
        return fn;
      });
  }
  return removeBackgroundFnPromise;
}

async function getSegmentImageBlob(seg) {
  if (getSegmentMediaKind(seg) !== 'image') {
    throw new Error('Remove BG only supports image overlays');
  }
  if (seg.imageBinary?.blob) {
    const t = String(seg.imageBinary.blob.type || '').toLowerCase();
    if (t.startsWith('video/')) {
      throw new Error('Remove BG does not support video overlays yet');
    }
    return seg.imageBinary.blob;
  }
  if (seg.imageUrl) {
    let res;
    try {
      res = await fetch(seg.imageUrl);
    } catch (error) {
      throw new Error(`Image fetch blocked (CORS/network). Upload file instead or use a CORS-enabled URL.`);
    }
    if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
    let blob;
    try {
      blob = await res.blob();
    } catch (error) {
      throw new Error('Image response could not be read as Blob (likely CORS/hotlink restriction).');
    }
    const t = String(blob.type || res.headers.get('content-type') || '').toLowerCase();
    if (t.startsWith('video/')) {
      throw new Error('Remove BG does not support video overlays yet');
    }
    return blob;
  }
  throw new Error('No image source');
}

async function getSegmentMediaBlob(seg) {
  if (seg.imageBinary?.blob) return seg.imageBinary.blob;
  if (seg.imageUrl) {
    let res;
    try {
      res = await fetch(seg.imageUrl);
    } catch (error) {
      throw new Error(`Media fetch blocked (CORS/network). Upload the media file locally instead.`);
    }
    if (!res.ok) throw new Error(`Media fetch failed (${res.status})`);
    try {
      return await res.blob();
    } catch (error) {
      throw new Error('Media response could not be read as Blob (likely CORS/hotlink restriction).');
    }
  }
  throw new Error('No media source');
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas encode failed'));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

function waitForEvent(target, type) {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve(true);
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`Event failed: ${type}`));
    };
    const cleanup = () => {
      target.removeEventListener(type, onOk);
      target.removeEventListener('error', onErr);
    };
    target.addEventListener(type, onOk, { once: true });
    target.addEventListener('error', onErr, { once: true });
  });
}

async function seekVideo(video, timeSec) {
  video.currentTime = Math.max(0, Number(timeSec) || 0);
  await waitForEvent(video, 'seeked');
}

async function removeBackgroundFromVideoOverlay(seg, statusPrefix = '') {
  const removeBackground = await getRemoveBackgroundFn();
  const srcBlob = await getSegmentMediaBlob(seg);
  const srcUrl = URL.createObjectURL(srcBlob);
  const tempVideo = document.createElement('video');
  tempVideo.muted = true;
  tempVideo.playsInline = true;
  tempVideo.preload = 'auto';
  tempVideo.src = srcUrl;
  await waitForEvent(tempVideo, 'loadedmetadata');

  const srcW = Math.max(2, tempVideo.videoWidth || 2);
  const srcH = Math.max(2, tempVideo.videoHeight || 2);
  const maxSide = Math.max(srcW, srcH);
  const scale = maxSide > VIDEO_BG_MAX_SIDE ? (VIDEO_BG_MAX_SIDE / maxSide) : 1;
  const width = Math.max(2, Math.round(srcW * scale));
  const height = Math.max(2, Math.round(srcH * scale));
  const duration = Math.max(0.01, Number(tempVideo.duration) || 0);
  const adaptiveFps = Math.round(VIDEO_BG_TARGET_FRAMES / duration);
  const fps = Math.max(VIDEO_BG_MIN_FPS, Math.min(VIDEO_BG_MAX_FPS, adaptiveFps));
  const frameCount = Math.max(1, Math.min(VIDEO_BG_MAX_FRAMES, Math.ceil(duration * fps)));

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = width;
  frameCanvas.height = height;
  const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  if (!frameCtx) throw new Error('Cannot create frame canvas context');

  const supportsGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
  let inferenceDevice = supportsGpu ? 'gpu' : 'cpu';
  setBgDevice(inferenceDevice);
  setStatus(`${statusPrefix} using ${inferenceDevice.toUpperCase()} (${width}x${height} @ ${fps}fps)`);

  const encoderWorker = new Worker(new URL('./alpha-encode-worker.js', import.meta.url), { type: 'module' });
  encoderWorker.postMessage({ type: 'start' });

  try {
    for (let i = 0; i < frameCount; i += 1) {
      const t = Math.min(Math.max(0, duration - (1 / (fps * 2))), i / fps);
      await seekVideo(tempVideo, t);
      frameCtx.clearRect(0, 0, width, height);
      frameCtx.drawImage(tempVideo, 0, 0, width, height);
      const frameBlob = await canvasToBlob(frameCanvas, 'image/png');
      let out;
      try {
        out = await removeBackground(frameBlob, {
          model: VIDEO_BG_MODEL,
          device: inferenceDevice
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (inferenceDevice === 'gpu') {
          inferenceDevice = 'cpu';
          setBgDevice(inferenceDevice);
          setStatus(`GPU failed, falling back to CPU (${msg})`);
          out = await removeBackground(frameBlob, {
            model: VIDEO_BG_MODEL,
            device: inferenceDevice
          });
        } else {
          throw new Error(`[remove-frame ${i + 1}/${frameCount}] ${msg}`);
        }
      }
      const outBlob = out instanceof Blob ? out : new Blob([out], { type: 'image/png' });
      const outBuffer = await outBlob.arrayBuffer();
      await new Promise((resolve, reject) => {
        const onMessage = (msgEvent) => {
          const data = msgEvent.data || {};
          if (data.type === 'frame-ack' && data.index === i) {
            encoderWorker.removeEventListener('message', onMessage);
            encoderWorker.removeEventListener('error', onError);
            resolve(true);
          }
        };
        const onError = () => {
          encoderWorker.removeEventListener('message', onMessage);
          encoderWorker.removeEventListener('error', onError);
          reject(new Error('Video frame enqueue failed'));
        };
        encoderWorker.addEventListener('message', onMessage);
        encoderWorker.addEventListener('error', onError);
        encoderWorker.postMessage({ type: 'frame', index: i, buffer: outBuffer }, [outBuffer]);
      });
      setStatus(`${statusPrefix} ${i + 1}/${frameCount} (${inferenceDevice.toUpperCase()} ${width}x${height} @ ${fps}fps)`);
    }

    const outBuffer = await new Promise((resolve, reject) => {
      encoderWorker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'progress') {
          const p = Math.max(0, Math.min(100, Math.round((Number(data.progress) || 0) * 100)));
          setStatus(`Encoding transparent video ${p}%`);
          return;
        }
        if (data.type === 'status') {
          if (data.stage === 'chunk-encode') {
            setStatus(`Chunk encoding ${data.chunk}/${data.totalChunks} (${data.frames} frames)`);
            return;
          }
          if (data.stage === 'chunk-concat') {
            setStatus(`Concatenating ${data.totalChunks} chunks...`);
            return;
          }
        }
        if (data.type === 'done') {
          resolve(data.buffer);
          return;
        }
        if (data.type === 'error') {
          reject(new Error(`[encode] ${data.message || 'Video encode failed'}`));
        }
      };
      encoderWorker.onerror = (err) => {
        const msg = err instanceof ErrorEvent ? (err.message || 'Video worker failed') : 'Video worker failed';
        reject(new Error(`[encode-worker] ${msg}`));
      };
      encoderWorker.postMessage({ type: 'encode', fps, chunkSize: VIDEO_BG_ENCODE_CHUNK_SIZE });
    });

    return new Blob([outBuffer], { type: 'video/webm' });
  } finally {
    setBgDevice('idle');
    encoderWorker.terminate();
    URL.revokeObjectURL(srcUrl);
  }
}

function revokeObjectUrl(url) {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch (_) {}
}

function getSegmentPreviewSrc(seg) {
  if (seg.imageBinary) {
    if (!seg.imageObjectUrl) {
      seg.imageObjectUrl = URL.createObjectURL(seg.imageBinary.blob);
    }
    return seg.imageObjectUrl;
  }
  return seg.imageUrl || '';
}

function setVideoSourceFromBinary(blob, name = 'input.mp4', type = 'video/mp4') {
  if (!blob) return;
  state.videoBinary = { blob, name, type };
  state.videoUrl = '';
  revokeObjectUrl(state.videoObjectUrl);
  state.videoObjectUrl = URL.createObjectURL(blob);
}

function openDraftDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DRAFT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        db.createObjectStore(DRAFT_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function idbGetDraft() {
  const db = await openDraftDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE_NAME, 'readonly');
    const store = tx.objectStore(DRAFT_STORE_NAME);
    const req = store.get(DRAFT_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
  });
}

async function idbSetDraft(payload) {
  const db = await openDraftDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = tx.objectStore(DRAFT_STORE_NAME);
    store.put(payload, DRAFT_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB put failed'));
  });
}

async function idbClearDraft() {
  const db = await openDraftDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = tx.objectStore(DRAFT_STORE_NAME);
    store.delete(DRAFT_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
  });
}

function tcToSeconds(tc, fps = FPS) {
  const parts = String(tc || '').trim().split(':').map((x) => Number(x));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    const [mm, ss, ff] = parts;
    return (mm * 60) + ss + (ff / fps);
  }
  if (parts.length === 4) {
    const [hh, mm, ss, ff] = parts;
    return (hh * 3600) + (mm * 60) + ss + (ff / fps);
  }
  return 0;
}

function ensureWorker() {
  if (state.worker) return state.worker;
  state.worker = new Worker(new URL('./retard-worker.js', import.meta.url), { type: 'module' });
  return state.worker;
}

function scheduleDraftSave() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    (async () => {
      try {
        const payload = {
          savedAt: new Date().toISOString(),
          videoSource: state.videoBinary
            ? {
                kind: 'binary',
                name: state.videoBinary.name || 'input.mp4',
                type: state.videoBinary.type || 'video/mp4',
                blob: state.videoBinary.blob
              }
            : {
                kind: 'url',
                url: state.videoUrl || ''
              },
          transitionMode: state.transitionMode,
          crossfadeSec: state.crossfadeSec,
          segments: state.segments.map((seg) => ({
            id: seg.id,
            name: seg.name,
            start: seg.start,
            end: seg.end,
            x: seg.x,
            y: seg.y,
            width: seg.width,
            height: seg.height,
            imageSource: seg.imageBinary
              ? {
                  kind: 'binary',
                  name: seg.imageBinary.name || 'overlay.png',
                  type: seg.imageBinary.type || 'image/png',
                  blob: seg.imageBinary.blob
                }
              : {
                  kind: 'url',
                  url: seg.imageUrl || ''
                }
          }))
        };
        await idbSetDraft(payload);
        const savedAt = document.getElementById('retard-draft-saved-at');
        if (savedAt) {
          savedAt.textContent = `Draft saved ${new Date(payload.savedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
        }
      } catch (error) {
        console.warn('Draft save failed', error);
      }
    })();
  }, 250);
}

function clearDraft() {
  idbClearDraft()
    .catch((error) => console.warn('Draft clear failed', error))
    .finally(() => {
      const savedAt = document.getElementById('retard-draft-saved-at');
      if (savedAt) savedAt.textContent = 'No draft saved';
    });
}

async function loadDraft() {
  const parsed = await idbGetDraft();
  if (!parsed) return false;
  try {
    if (parsed.videoSource?.kind === 'binary' && parsed.videoSource.blob) {
      setVideoSourceFromBinary(parsed.videoSource.blob, parsed.videoSource.name, parsed.videoSource.type);
    } else {
      state.videoBinary = null;
      state.videoUrl = parsed.videoSource?.url || state.videoUrl;
      revokeObjectUrl(state.videoObjectUrl);
      state.videoObjectUrl = '';
    }
    state.transitionMode = parsed.transitionMode === 'xfade' ? 'xfade' : 'cut';
    state.crossfadeSec = Math.max(0.05, Number(parsed.crossfadeSec) || 0.2);
    if (Array.isArray(parsed.segments) && parsed.segments.length) {
      const merged = [];
      for (let i = 0; i < parsed.segments.length; i += 1) {
        const src = parsed.segments[i] || {};
        const imageSource = src.imageSource || { kind: 'url', url: src.imageUrl || '' };
        merged.push({
          id: src.id || `seg_${i}`,
          name: String(src.name || ''),
          start: String(src.start || EMPTY_TIMECODE),
          end: String(src.end || EMPTY_TIMECODE),
          x: Math.max(0, Math.min(100, Number(src.x) || 50)),
          y: Math.max(0, Math.min(100, Number(src.y) || 90)),
          width: Math.max(0.1, Math.min(MAX_OVERLAY_PERCENT, Number(src.width) || 100)),
          height: Math.max(0.1, Math.min(MAX_OVERLAY_PERCENT, Number(src.height) || 100)),
          imageBinary: imageSource.kind === 'binary' && imageSource.blob
            ? {
                blob: imageSource.blob,
                name: imageSource.name || 'overlay.png',
                type: imageSource.type || 'image/png'
              }
            : null,
          imageObjectUrl: '',
          imageUrl: imageSource.kind === 'url' ? String(imageSource.url || '') : ''
        });
      }
      state.segments = merged;
    }
    const savedAt = document.getElementById('retard-draft-saved-at');
    if (savedAt) {
      const ts = parsed.savedAt ? new Date(parsed.savedAt) : new Date();
      savedAt.textContent = `Draft loaded ${ts.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
    }
    return true;
  } catch (error) {
    console.warn('Draft load failed', error);
    return false;
  }
}

function setStatus(text) {
  const el = document.getElementById('retard-status');
  if (el) el.textContent = text;
}

function setBgDevice(device) {
  const normalized = String(device || 'idle').toLowerCase();
  state.bgRemoveDevice = normalized;
  const el = document.getElementById('retard-bg-device');
  if (!el) return;
  if (normalized === 'gpu') {
    el.textContent = 'Remove BG Device: GPU';
    return;
  }
  if (normalized === 'cpu') {
    el.textContent = 'Remove BG Device: CPU';
    return;
  }
  el.textContent = 'Remove BG Device: Idle';
}

function activeSegmentAt(timeSec) {
  return state.segments.find((seg) => {
    if (!hasSegmentMedia(seg)) return false;
    const startSec = tcToSeconds(seg.start);
    const endSec = tcToSeconds(seg.end);
    return timeSec >= startSec && timeSec <= endSec;
  }) || null;
}

function updateOverlayPreview() {
  const video = document.getElementById('retard-video');
  const wrap = document.querySelector('.retard-video-wrap');
  const overlayImage = document.getElementById('retard-overlay-image');
  const overlayVideo = document.getElementById('retard-overlay-video');
  if (!video || !overlayImage || !overlayVideo || !wrap) return;
  const seg = activeSegmentAt(video.currentTime);
  if (!seg) {
    overlayImage.style.display = 'none';
    overlayVideo.style.display = 'none';
    overlayImage.removeAttribute('src');
    overlayVideo.pause();
    overlayVideo.removeAttribute('src');
    return;
  }
  const vw = video.videoWidth || state.videoMeta.width || 1;
  const vh = video.videoHeight || state.videoMeta.height || 1;
  const wrapW = wrap.clientWidth || 1;
  const wrapH = wrap.clientHeight || 1;
  const videoAspect = vw / vh;
  const wrapAspect = wrapW / wrapH;
  let drawW = wrapW;
  let drawH = wrapH;
  let offsetX = 0;
  let offsetY = 0;
  if (videoAspect > wrapAspect) {
    drawH = wrapW / videoAspect;
    offsetY = (wrapH - drawH) / 2;
  } else {
    drawW = wrapH * videoAspect;
    offsetX = (wrapW - drawW) / 2;
  }

  const mediaKind = getSegmentMediaKind(seg);
  const overlay = mediaKind === 'video' ? overlayVideo : overlayImage;
  const other = mediaKind === 'video' ? overlayImage : overlayVideo;
  const src = getSegmentPreviewSrc(seg);

  other.style.display = 'none';
  if (other instanceof HTMLVideoElement) {
    other.pause();
    other.removeAttribute('src');
  } else {
    other.removeAttribute('src');
  }

  if (mediaKind === 'video') {
    if (overlayVideo.getAttribute('src') !== src) {
      overlayVideo.src = src;
      overlayVideo.muted = true;
      overlayVideo.playsInline = true;
      overlayVideo.preload = 'auto';
    }
    const startSec = tcToSeconds(seg.start);
    const overlayT = Math.max(0, video.currentTime - startSec);
    if (Math.abs((overlayVideo.currentTime || 0) - overlayT) > 0.2) {
      overlayVideo.currentTime = overlayT;
    }
    if (video.paused) {
      overlayVideo.pause();
    } else {
      overlayVideo.play().catch(() => {});
    }
  } else {
    if (overlayImage.getAttribute('src') !== src) {
      overlayImage.src = src;
    }
  }

  overlay.style.display = 'block';
  const wPx = drawW * (seg.width / 100);
  const hPx = drawH * (seg.height / 100);
  const cxPx = offsetX + (drawW * (seg.x / 100));
  const cyPx = offsetY + (drawH * (seg.y / 100));
  overlay.style.left = `${cxPx - (wPx / 2)}px`;
  overlay.style.top = `${cyPx - (hPx / 2)}px`;
  overlay.style.width = `${wPx}px`;
  overlay.style.height = `${hPx}px`;
}

function renderSegmentsTable() {
  const tbody = document.getElementById('retard-segments-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  state.segments.forEach((seg) => {
    const tr = document.createElement('tr');
    tr.dataset.id = seg.id;
    tr.innerHTML = `
      <td class="seg-handle-cell"><span class="seg-handle" draggable="true" data-id="${seg.id}" title="Drag to reorder">☰</span></td>
      <td><input data-id="${seg.id}" data-k="name" value="${seg.name}" /></td>
      <td><input data-id="${seg.id}" data-k="start" value="${seg.start}" /></td>
      <td><input data-id="${seg.id}" data-k="end" value="${seg.end}" /></td>
      <td><input data-id="${seg.id}" data-k="x" type="number" min="0" max="100" step="0.1" value="${seg.x}" /></td>
      <td><input data-id="${seg.id}" data-k="y" type="number" min="0" max="100" step="0.1" value="${seg.y}" /></td>
      <td><input data-id="${seg.id}" data-k="width" type="number" min="0.1" max="${MAX_OVERLAY_PERCENT}" step="0.1" value="${seg.width}" /></td>
      <td><input data-id="${seg.id}" data-k="height" type="number" min="0.1" max="${MAX_OVERLAY_PERCENT}" step="0.1" value="${seg.height}" /></td>
      <td><input data-id="${seg.id}" data-k="file" type="file" accept="image/*,video/*" /></td>
      <td><input data-id="${seg.id}" data-k="imageUrl" placeholder="https://... or data:*/*;base64,..." value="${seg.imageUrl || ''}" /></td>
      <td>${hasSegmentMedia(seg)
        ? (getSegmentMediaKind(seg) === 'video'
            ? `<video class="seg-thumb" src="${getSegmentPreviewSrc(seg)}" muted playsinline preload="metadata"></video>`
            : `<img class="seg-thumb" src="${getSegmentPreviewSrc(seg)}" alt="thumb" />`)
        : ''}</td>
      <td class="seg-actions">
        <button type="button" data-action="play" data-id="${seg.id}">Play</button>
        <button type="button" data-action="removebg" data-id="${seg.id}" ${getSegmentMediaKind(seg) === 'video' ? 'title="Remove BG supports images only"' : ''}>Remove BG</button>
        <button type="button" data-action="clearmedia" data-id="${seg.id}" ${hasSegmentMedia(seg) ? '' : 'disabled'}>Clear Media</button>
        <button type="button" data-action="duplicate" data-id="${seg.id}">Duplicate</button>
        <button type="button" data-action="delete" data-id="${seg.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function bindSegmentEvents() {
  const tbody = document.getElementById('retard-segments-body');
  if (!tbody) return;
  if (tbody.dataset.bound === '1') return;
  tbody.dataset.bound = '1';
  let draggingSegId = '';

  const applyReorder = (dragId, targetId, placeAfter) => {
    if (!dragId || !targetId || dragId === targetId) return false;
    const fromIdx = state.segments.findIndex((s) => s.id === dragId);
    const targetIdx = state.segments.findIndex((s) => s.id === targetId);
    if (fromIdx < 0 || targetIdx < 0) return false;
    const [moved] = state.segments.splice(fromIdx, 1);
    let insertIdx = targetIdx;
    if (fromIdx < targetIdx) insertIdx -= 1;
    if (placeAfter) insertIdx += 1;
    if (insertIdx < 0) insertIdx = 0;
    if (insertIdx > state.segments.length) insertIdx = state.segments.length;
    state.segments.splice(insertIdx, 0, moved);
    return true;
  };

  tbody.addEventListener('dragstart', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const handle = target.closest('.seg-handle');
    if (!handle) return;
    draggingSegId = String(handle.getAttribute('data-id') || '');
    if (!draggingSegId) return;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggingSegId);
    }
  });

  tbody.addEventListener('dragover', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const row = event.target.closest('tr');
    if (!(row instanceof HTMLTableRowElement)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = draggingSegId ? 'move' : 'copy';
    }
  });

  tbody.addEventListener('drop', (event) => {
    event.preventDefault();
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest('tr');
    if (!(row instanceof HTMLTableRowElement)) return;
    const targetId = String(row.dataset.id || '');
    if (!targetId) return;
    const targetSeg = state.segments.find((s) => s.id === targetId);
    if (!targetSeg) return;

    if (draggingSegId) {
      if (targetId === draggingSegId) return;
      const rect = row.getBoundingClientRect();
      const placeAfter = (event.clientY - rect.top) > (rect.height / 2);
      if (applyReorder(draggingSegId, targetId, placeAfter)) {
        renderSegmentsTable();
        scheduleDraftSave();
        setStatus('Reordered segments');
      }
      return;
    }

    const dt = event.dataTransfer;
    if (!dt) return;

    const droppedFile = Array.from(dt.files || []).find((f) =>
      String(f.type || '').startsWith('image/') || String(f.type || '').startsWith('video/')
    );
    if (droppedFile) {
      assignImageBlobToSegment(
        targetSeg,
        droppedFile,
        droppedFile.name || `dropped-${Date.now()}`,
        droppedFile.type || 'application/octet-stream'
      );
      renderSegmentsTable();
      updateOverlayPreview();
      scheduleDraftSave();
      setStatus(`Applied dropped media to "${targetSeg.name || 'segment'}"`);
      return;
    }

    const droppedUrl = String(dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim();
    if (droppedUrl) {
      try {
        const parsed = new URL(droppedUrl);
        if (/^https?:$/i.test(parsed.protocol) || /^data:/i.test(parsed.protocol)) {
          assignMediaUrlToSegment(targetSeg, parsed.toString());
          renderSegmentsTable();
          updateOverlayPreview();
          scheduleDraftSave();
          setStatus(`Applied dropped URL to "${targetSeg.name || 'segment'}"`);
        }
      } catch (_) {
        // Ignore non-URL text drops
      }
    }
  });

  tbody.addEventListener('dragend', () => {
    draggingSegId = '';
  });
  tbody.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const id = target.dataset.id;
    const key = target.dataset.k;
    if (!id || !key || key === 'file') return;
    const seg = state.segments.find((s) => s.id === id);
    if (!seg) return;
    if (['x', 'y', 'width', 'height'].includes(key)) {
      const n = Number(target.value);
      if (key === 'width' || key === 'height') {
        seg[key] = Math.max(0.1, Math.min(MAX_OVERLAY_PERCENT, Number.isFinite(n) ? n : 0.1));
      } else {
        seg[key] = Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
      }
    } else if (key === 'imageUrl') {
      assignMediaUrlToSegment(seg, target.value);
    } else {
      seg[key] = target.value;
    }
    updateOverlayPreview();
    scheduleDraftSave();
  });

  tbody.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.k !== 'file') return;
    const id = target.dataset.id;
    const seg = state.segments.find((s) => s.id === id);
    if (!seg) return;
    const file = target.files?.[0] || null;
    if (!file) {
      renderSegmentsTable();
      updateOverlayPreview();
      scheduleDraftSave();
      return;
    }
    assignImageBlobToSegment(
      seg,
      file,
      file.name || 'overlay.bin',
      file.type || 'application/octet-stream'
    );
    renderSegmentsTable();
    updateOverlayPreview();
    scheduleDraftSave();
  });

  tbody.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    const id = target.getAttribute('data-id');
    if (!action || !id) return;
    const idx = state.segments.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const seg = state.segments[idx];
    if (action === 'duplicate') {
      const src = seg;
      const clone = {
        ...src,
        id: `seg_${segmentCounter++}`,
        imageObjectUrl: ''
      };
      state.segments.splice(idx + 1, 0, clone);
      renderSegmentsTable();
      scheduleDraftSave();
      setStatus(`Duplicated "${src.name}"`);
      return;
    }
    if (action === 'play') {
      const video = document.getElementById('retard-video');
      if (!(video instanceof HTMLVideoElement)) return;
      if (state.segmentPreviewId === seg.id && !video.paused) {
        video.pause();
        setStatus(`Paused "${seg.name}"`);
        return;
      }
      const startSec = tcToSeconds(seg.start);
      const endSec = tcToSeconds(seg.end);
      if (endSec <= startSec) {
        setStatus('Invalid segment timing');
        return;
      }
      video.currentTime = startSec;
      state.segmentPreviewId = seg.id;
      state.segmentPreviewStartSec = startSec;
      state.segmentPreviewEndSec = endSec;
      video.play().catch(() => {});
      setStatus(`Previewing "${seg.name}"`);
      return;
    }
    if (action === 'clearmedia') {
      clearSegmentMedia(seg);
      renderSegmentsTable();
      updateOverlayPreview();
      scheduleDraftSave();
      setStatus(`Cleared media for "${seg.name}"`);
      return;
    }
    if (action === 'removebg') {
      if (!hasSegmentMedia(seg)) {
        setStatus('No image to process');
        return;
      }
      const btn = target.closest('button');
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      (async () => {
        try {
          const mediaKind = getSegmentMediaKind(seg);
          if (mediaKind === 'video') {
            setStatus(`Removing video background for "${seg.name}"...`);
            const outVideoBlob = await removeBackgroundFromVideoOverlay(seg, 'Removing video background');
            assignImageBlobToSegment(
              seg,
              outVideoBlob,
              `nobg-${Date.now()}.webm`,
              'video/webm'
            );
          } else {
            setStatus(`Removing background for "${seg.name}"...`);
            const removeBackground = await getRemoveBackgroundFn();
            setBgDevice('cpu');
            const inputBlob = await getSegmentImageBlob(seg);
            const output = await removeBackground(inputBlob, {
              progress: (key, current, total) => {
                if (typeof current === 'number' && typeof total === 'number' && total > 0) {
                  const p = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
                  setStatus(`Removing background ${p}%`);
                } else if (typeof current === 'number') {
                  const p = Math.max(0, Math.min(100, Math.round(current * 100)));
                  setStatus(`Removing background ${p}%`);
                } else {
                  setStatus(`Removing background (${String(key || 'working')})`);
                }
              }
            });
            setBgDevice('idle');
            const outBlob = output instanceof Blob ? output : new Blob([output], { type: 'image/png' });
            assignImageBlobToSegment(
              seg,
              outBlob,
              `nobg-${Date.now()}.png`,
              outBlob.type || 'image/png'
            );
          }
          renderSegmentsTable();
          updateOverlayPreview();
          scheduleDraftSave();
          setStatus(`Background removed for "${seg.name}"`);
        } catch (error) {
          setBgDevice('idle');
          setStatus(`Remove BG failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBgDevice('idle');
          if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
      })();
      return;
    }
    if (action === 'delete') {
      const removed = seg;
      state.segments.splice(idx, 1);
      renderSegmentsTable();
      updateOverlayPreview();
      scheduleDraftSave();
      setStatus(`Deleted "${removed.name}"`);
    }
  });
}

async function fetchVideoBuffer() {
  if (state.videoBinary?.blob) {
    return {
      name: state.videoBinary.name || 'input.mp4',
      buffer: await state.videoBinary.blob.arrayBuffer()
    };
  }
  if (!state.videoUrl) throw new Error('Missing video URL or uploaded file');
  const res = await fetch(state.videoUrl);
  if (!res.ok) throw new Error(`Video fetch failed (${res.status})`);
  const name = (state.videoUrl.split('/').pop() || 'input.mp4').split('?')[0];
  return { name, buffer: await res.arrayBuffer() };
}

function sanitizeFileStem(name, fallback = 'overlay') {
  const raw = String(name || '').trim();
  const base = raw.split('/').pop()?.split('?')[0] || '';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || fallback;
}

function imageTypeToExt(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('webp')) return 'webp';
  return 'png';
}

async function convertImageBlobToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, bitmap.width);
    canvas.height = Math.max(1, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise((resolve, reject) => {
      canvas.toBlob((out) => {
        if (!out) {
          reject(new Error('Canvas PNG conversion failed'));
          return;
        }
        resolve(out);
      }, 'image/png');
    });
    return pngBlob;
  } finally {
    bitmap.close();
  }
}

async function normalizeOverlayMediaForExport(seg) {
  const mediaKind = getSegmentMediaKind(seg);
  const baseStem = sanitizeFileStem(seg.name || 'overlay', 'overlay');
  if (seg.imageBinary?.blob) {
    const srcBlob = seg.imageBinary.blob;
    if (mediaKind === 'video') {
      const ext = (String(seg.imageBinary.name || '').toLowerCase().includes('.webm')) ? 'webm' : 'mp4';
      return { mediaKind, mediaName: `${baseStem}.${ext}`, mediaBuffer: await srcBlob.arrayBuffer() };
    }
    const srcType = String(srcBlob.type || '').toLowerCase();
    const supported = srcType.includes('png') || srcType.includes('jpeg') || srcType.includes('jpg') || srcType.includes('webp');
    const outBlob = supported ? srcBlob : await convertImageBlobToPng(srcBlob);
    const ext = imageTypeToExt(outBlob.type);
    return { mediaKind: 'image', mediaName: `${baseStem}.${ext}`, mediaBuffer: await outBlob.arrayBuffer() };
  }

  if (seg.imageUrl) {
    const res = await fetch(seg.imageUrl);
    if (!res.ok) throw new Error(`Media fetch failed (${res.status})`);
    const srcBlob = await res.blob();
    const responseType = String(srcBlob.type || res.headers.get('content-type') || '').toLowerCase();
    const isVideo = responseType.startsWith('video/') || mediaKind === 'video';
    if (isVideo) {
      const ext = responseType.includes('webm') ? 'webm' : 'mp4';
      return { mediaKind: 'video', mediaName: `${baseStem}.${ext}`, mediaBuffer: await srcBlob.arrayBuffer() };
    }
    const supported = responseType.includes('png') || responseType.includes('jpeg') || responseType.includes('jpg') || responseType.includes('webp');
    const outBlob = supported ? srcBlob : await convertImageBlobToPng(srcBlob);
    const ext = imageTypeToExt(outBlob.type);
    return { mediaKind: 'image', mediaName: `${baseStem}.${ext}`, mediaBuffer: await outBlob.arrayBuffer() };
  }

  throw new Error('No media source');
}

async function exportVideo() {
  const selectedSegments = state.segments.filter((seg) => hasSegmentMedia(seg) && seg.start && seg.end);
  if (!selectedSegments.length) {
    setStatus('No segment selected (upload at least one image)');
    return;
  }

  setStatus('Preparing render...');
  const exportBtn = document.getElementById('retard-export-btn');
  if (exportBtn) exportBtn.disabled = true;

  try {
    const worker = ensureWorker();
    const { name, buffer } = await fetchVideoBuffer();
    const transfer = [buffer];
    const payloadSegments = [];

    for (const seg of selectedSegments) {
      const { mediaBuffer, mediaName, mediaKind } = await normalizeOverlayMediaForExport(seg);
      transfer.push(mediaBuffer);
      payloadSegments.push({
        name: seg.name,
        startSec: tcToSeconds(seg.start),
        endSec: tcToSeconds(seg.end),
        xPercent: Math.max(0, Math.min(100, Number(seg.x) || 0)),
        yPercent: Math.max(0, Math.min(100, Number(seg.y) || 0)),
        widthPercent: Math.max(0.1, Math.min(MAX_OVERLAY_PERCENT, Number(seg.width) || 0.1)),
        heightPercent: Math.max(0.1, Math.min(MAX_OVERLAY_PERCENT, Number(seg.height) || 0.1)),
        videoWidth: state.videoMeta.width || 1920,
        videoHeight: state.videoMeta.height || 1080,
        mediaKind,
        mediaName,
        mediaBuffer
      });
    }

    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'progress') {
          const p = Math.round((Number(data.progress) || 0) * 100);
          setStatus(`Encoding ${p}%`);
          return;
        }
        if (data.type === 'done') {
          resolve(data.buffer);
          return;
        }
        if (data.type === 'error') {
          const err = new Error(data.message || 'Render failed');
          err.details = data.details || null;
          reject(err);
        }
      };
      worker.onerror = (err) => {
        const detail = {
          message: err?.message || 'Worker error',
          filename: err?.filename || '',
          lineno: err?.lineno || 0,
          colno: err?.colno || 0,
          error: err?.error || null
        };
        const wrapped = new Error(detail.message || 'Worker error');
        wrapped.details = detail;
        reject(wrapped);
      };
      worker.postMessage({
        type: 'render',
        payload: {
          videoName: name || 'input.mp4',
          videoBuffer: buffer,
          segments: payloadSegments,
          fps: FPS,
          transitionMode: state.transitionMode,
          crossfadeSec: state.crossfadeSec,
          preserveAudio: true
        }
      }, transfer);
    });

    const blob = new Blob([result], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'retard-overlay.mp4';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus('Done');
  } catch (error) {
    console.error('[export] full error', error);
    console.error('[export] details', error?.details || null);
    try {
      const json = JSON.stringify(error?.details || null, null, 2);
      console.error('[export] details-json\n' + json);
      window.lastExportErrorText = json;
    } catch (_) {
      window.lastExportErrorText = '';
    }
    window.lastExportError = {
      message: error instanceof Error ? error.message : String(error),
      details: error?.details || null,
      at: new Date().toISOString()
    };
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (exportBtn) exportBtn.disabled = false;
  }
}

async function mount() {
  document.title = 'Retard Overlay Tool';
  document.body.innerHTML = `
    <div class="retard-page">
      <h1>Video Overlay Tool</h1>
      <div class="retard-top-grid">
        <div class="retard-video-column">
          <div class="retard-preview">
            <div class="retard-video-wrap">
              <video id="retard-video" crossorigin="anonymous"></video>
              <img id="retard-overlay-image" alt="overlay image" />
              <video id="retard-overlay-video" muted playsinline preload="auto"></video>
            </div>
            <div class="retard-video-controls">
              <button id="retard-play-toggle-btn" type="button">Play</button>
              <button id="retard-restart-btn" type="button">Restart</button>
              <input id="retard-seek" type="range" min="0" max="1000" value="0" />
              <span id="retard-time-label">00:00 / 00:00</span>
            </div>
            <div id="retard-status">Ready</div>
            <div id="retard-bg-device">Remove BG Device: Idle</div>
          </div>
        </div>
        <div class="retard-tool-column">
          <div class="retard-controls">
            <div class="retard-inline-row">
              <label>Video URL <input id="retard-video-url" placeholder="https://..." /></label>
              <label>Or Upload Video <input id="retard-video-file" type="file" accept="video/*" /></label>
            </div>
            <button id="retard-load-btn">Load Video</button>
            <div class="retard-inline-row">
              <label>Transition
                <select id="retard-transition-mode">
                  <option value="cut">Cut</option>
                  <option value="xfade">Crossfade</option>
                </select>
              </label>
              <label>Crossfade (s) <input id="retard-crossfade-sec" type="number" min="0.05" step="0.05" value="0.2" /></label>
            </div>
            <div class="retard-button-row">
              <button id="retard-export-btn">Export MP4</button>
              <button id="retard-add-segment-btn">Add Segment</button>
            </div>
            <div class="retard-button-row">
              <button id="retard-save-draft-btn">Save Draft</button>
              <button id="retard-load-draft-btn">Load Draft</button>
              <button id="retard-clear-draft-btn">Clear Draft</button>
            </div>
          </div>
          <div id="retard-draft-saved-at">No draft saved</div>
        </div>
      </div>
      <div class="retard-table-wrap">
        <table class="retard-table">
          <thead>
            <tr>
              <th>Order</th><th>Name</th><th>Start (MM:SS:FF)</th><th>End</th><th>X%</th><th>Y%</th><th>W%</th><th>H%</th><th>Media File</th><th>Media URL</th><th>Preview</th><th>Actions</th>
            </tr>
          </thead>
          <tbody id="retard-segments-body"></tbody>
        </table>
      </div>
    </div>
  `;

  renderSegmentsTable();
  bindSegmentEvents();

  const video = document.getElementById('retard-video');
  const loadBtn = document.getElementById('retard-load-btn');
  const exportBtn = document.getElementById('retard-export-btn');
  const urlInput = document.getElementById('retard-video-url');
  const fileInput = document.getElementById('retard-video-file');
  const transitionSelect = document.getElementById('retard-transition-mode');
  const crossfadeInput = document.getElementById('retard-crossfade-sec');
  const saveDraftBtn = document.getElementById('retard-save-draft-btn');
  const loadDraftBtn = document.getElementById('retard-load-draft-btn');
  const clearDraftBtn = document.getElementById('retard-clear-draft-btn');
  const addSegmentBtn = document.getElementById('retard-add-segment-btn');
  const playToggleBtn = document.getElementById('retard-play-toggle-btn');
  const restartBtn = document.getElementById('retard-restart-btn');
  const seek = document.getElementById('retard-seek');
  const timeLabel = document.getElementById('retard-time-label');

  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };

  video?.addEventListener('timeupdate', updateOverlayPreview);
  video?.addEventListener('timeupdate', () => {
    updateOverlayPreview();
    if (state.segmentPreviewEndSec !== null && video.currentTime >= state.segmentPreviewEndSec) {
      video.pause();
      if (state.segmentPreviewStartSec !== null) {
        video.currentTime = state.segmentPreviewStartSec;
      }
      state.segmentPreviewId = '';
      state.segmentPreviewStartSec = null;
      state.segmentPreviewEndSec = null;
    }
    if (seek instanceof HTMLInputElement && Number.isFinite(video.duration) && video.duration > 0) {
      seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    }
    if (timeLabel) {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      timeLabel.textContent = `${fmt(video.currentTime)} / ${fmt(dur)}`;
    }
  });
  video?.addEventListener('seeked', updateOverlayPreview);
  video?.addEventListener('play', updateOverlayPreview);
  video?.addEventListener('play', () => {
    if (playToggleBtn) playToggleBtn.textContent = 'Pause';
  });
  video?.addEventListener('pause', () => {
    if (playToggleBtn) playToggleBtn.textContent = 'Play';
    updateOverlayPreview();
  });
  video?.addEventListener('loadedmetadata', () => {
    state.videoMeta = {
      width: video.videoWidth || 0,
      height: video.videoHeight || 0
    };
    if (timeLabel) {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      timeLabel.textContent = `${fmt(0)} / ${fmt(dur)}`;
    }
    updateOverlayPreview();
  });

  playToggleBtn?.addEventListener('click', () => {
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.paused) {
      state.segmentPreviewId = '';
      state.segmentPreviewStartSec = null;
      state.segmentPreviewEndSec = null;
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  });
  restartBtn?.addEventListener('click', () => {
    if (!(video instanceof HTMLVideoElement)) return;
    state.segmentPreviewId = '';
    state.segmentPreviewStartSec = null;
    state.segmentPreviewEndSec = null;
    video.currentTime = 0;
    video.play().catch(() => {});
  });
  seek?.addEventListener('input', () => {
    if (!(video instanceof HTMLVideoElement)) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const raw = Number(seek.value) || 0;
    video.currentTime = (raw / 1000) * video.duration;
    updateOverlayPreview();
  });

  transitionSelect?.addEventListener('change', () => {
    state.transitionMode = transitionSelect.value === 'xfade' ? 'xfade' : 'cut';
    scheduleDraftSave();
  });
  crossfadeInput?.addEventListener('input', () => {
    state.crossfadeSec = Math.max(0.05, Number(crossfadeInput.value) || 0.2);
    scheduleDraftSave();
  });

  loadBtn?.addEventListener('click', () => {
    const url = String(urlInput?.value || '').trim();
    const file = fileInput?.files?.[0] || null;
    state.videoUrl = url;
    state.videoBinary = null;
    state.segmentPreviewId = '';
    state.segmentPreviewStartSec = null;
    scheduleDraftSave();
    if (file) {
      setVideoSourceFromBinary(file, file.name || 'input.mp4', file.type || 'video/mp4');
      video.src = state.videoObjectUrl;
      state.segmentPreviewId = '';
      state.segmentPreviewStartSec = null;
      state.segmentPreviewEndSec = null;
      setStatus('Loaded local video');
      scheduleDraftSave();
      return;
    }
    if (!url) {
      setStatus('Provide a video URL or file');
      return;
    }
    revokeObjectUrl(state.videoObjectUrl);
    state.videoObjectUrl = '';
    video.src = url;
    state.segmentPreviewId = '';
    state.segmentPreviewStartSec = null;
    state.segmentPreviewEndSec = null;
    setStatus('Loaded video URL');
  });

  exportBtn?.addEventListener('click', exportVideo);
  addSegmentBtn?.addEventListener('click', () => {
    state.segments.push({
      id: `seg_${segmentCounter++}`,
      name: 'new segment',
      start: EMPTY_TIMECODE,
      end: EMPTY_TIMECODE,
      x: 50,
      y: 90,
      width: 100,
      height: 100,
      imageBinary: null,
      imageObjectUrl: '',
      imageUrl: ''
    });
    renderSegmentsTable();
    scheduleDraftSave();
    setStatus('Added segment');
  });
  saveDraftBtn?.addEventListener('click', () => {
    scheduleDraftSave();
    setStatus('Draft save requested');
  });
  loadDraftBtn?.addEventListener('click', async () => {
    if (!(await loadDraft())) {
      setStatus('No draft found');
      return;
    }
    renderSegmentsTable();
    if (urlInput) urlInput.value = state.videoUrl;
    if (transitionSelect) transitionSelect.value = state.transitionMode;
    if (crossfadeInput) crossfadeInput.value = String(state.crossfadeSec);
    if (state.videoBinary?.blob && state.videoObjectUrl) {
      video.src = state.videoObjectUrl;
    } else if (state.videoUrl) {
      video.src = state.videoUrl;
    }
    updateOverlayPreview();
    setStatus('Draft loaded');
  });
  clearDraftBtn?.addEventListener('click', () => {
    clearDraft();
    setStatus('Draft cleared');
  });

  document.addEventListener('paste', (event) => {
    const pasteTarget = resolvePasteTarget(event.target);
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) {
      if (!pasteTarget) return;
      const key = event.target.getAttribute('data-k');
      if (key === 'imageUrl' || key === 'name' || key === 'start' || key === 'end') {
        // Let normal input pasting happen for direct field edits.
        return;
      }
    }

    const items = Array.from(event.clipboardData?.items || []);
    const imgItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    const text = String(event.clipboardData?.getData('text/plain') || '').trim();

    const ensureTargetSeg = () => {
      if (pasteTarget) {
        const idx = state.segments.findIndex((seg) => seg.id === pasteTarget.id);
        return { idx, seg: pasteTarget };
      }
      let idx = findNextAvailableSegmentIndex();
      if (idx < 0) {
        state.segments.push({
          id: `seg_${segmentCounter++}`,
          name: 'pasted segment',
          start: EMPTY_TIMECODE,
          end: EMPTY_TIMECODE,
          x: 50,
          y: 90,
          width: 100,
          height: 100,
          imageBinary: null,
          imageObjectUrl: '',
          imageUrl: ''
        });
        idx = state.segments.length - 1;
      }
      return { idx, seg: state.segments[idx] };
    };

    if (imgItem) {
      const file = imgItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      const { idx, seg } = ensureTargetSeg();
      assignImageBlobToSegment(
        seg,
        file,
        file.name || `pasted-${Date.now()}.png`,
        file.type || 'image/png'
      );
      renderSegmentsTable();
      updateOverlayPreview();
      scheduleDraftSave();
      setStatus(`Pasted image into slot ${idx + 1} (${seg.name || 'segment'})`);
      return;
    }

    if (!text) return;
    let url = '';
    try {
      const parsed = new URL(text);
      if (!/^https?:$/i.test(parsed.protocol)) return;
      url = parsed.toString();
    } catch (_) {
      return;
    }
    const isLikelyImage = /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(url) || url.includes('upload.wikimedia.org/');
    if (!isLikelyImage) return;

    event.preventDefault();
    const { idx, seg } = ensureTargetSeg();
    assignMediaUrlToSegment(seg, url);
    renderSegmentsTable();
    updateOverlayPreview();
    scheduleDraftSave();
    setStatus(`Pasted image URL into slot ${idx + 1} (${seg.name || 'segment'})`);
  });

  if (await loadDraft()) {
    renderSegmentsTable();
  }
  segmentCounter = state.segments.reduce((max, seg) => {
    const m = /^seg_(\d+)$/.exec(String(seg.id || ''));
    const n = m ? Number(m[1]) : 0;
    return Math.max(max, Number.isFinite(n) ? n : 0);
  }, segmentCounter) + 1;
  if (urlInput) urlInput.value = state.videoUrl;
  if (transitionSelect) transitionSelect.value = state.transitionMode;
  if (crossfadeInput) crossfadeInput.value = String(state.crossfadeSec);
  if (state.videoBinary?.blob && state.videoObjectUrl) {
    video.src = state.videoObjectUrl;
    setStatus(`Loaded draft video binary`);
  } else if (state.videoUrl) {
    video.src = state.videoUrl;
    setStatus(`Loaded default video: ${state.videoUrl}`);
  }
  scheduleDraftSave();
}

mount();
