import { FFmpeg } from '@ffmpeg/ffmpeg';

let ffmpeg = null;
let ffmpegReadyPromise = null;
let recentLogs = [];

const classWorkerURL = new URL('../ffmpeg/ffmpeg-class-worker.js', self.location.href).href;
const coreURL = new URL('../ffmpeg/ffmpeg-core.js', self.location.href).href;
const wasmURL = new URL('../ffmpeg/ffmpeg-core.wasm', self.location.href).href;

async function ensureLoaded() {
  if (ffmpegReadyPromise) {
    await ffmpegReadyPromise;
    return ffmpeg;
  }
  ffmpegReadyPromise = (async () => {
    ffmpeg = new FFmpeg();
    await ffmpeg.load({
      classWorkerURL,
      coreURL,
      wasmURL
    });
    ffmpeg.on('progress', ({ progress }) => {
      self.postMessage({ type: 'progress', progress });
    });
    ffmpeg.on('log', ({ message }) => {
      const line = String(message || '').trim();
      if (!line) return;
      recentLogs.push(line);
      if (recentLogs.length > 120) recentLogs = recentLogs.slice(-120);
    });
  })();
  await ffmpegReadyPromise;
  return ffmpeg;
}

function getImageExt(fileName = '') {
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'jpg';
  if (lower.endsWith('.webp')) return 'webp';
  return 'png';
}

function getVideoExt(fileName = '') {
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith('.webm')) return 'webm';
  if (lower.endsWith('.mov')) return 'mov';
  if (lower.endsWith('.m4v')) return 'm4v';
  if (lower.endsWith('.ogg')) return 'ogg';
  return 'mp4';
}

function safeName(fileName, fallback = 'input.mp4') {
  const raw = String(fileName || '').trim();
  const base = raw.split('/').pop()?.split('?')[0] || '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned) return fallback;
  const dot = cleaned.lastIndexOf('.');
  const hasExt = dot > 0 && dot < cleaned.length - 1;
  const ext = hasExt ? cleaned.slice(dot) : '';
  const stem = hasExt ? cleaned.slice(0, dot) : cleaned;
  const cappedStem = stem.slice(0, 72);
  const cappedExt = ext.slice(0, 12);
  return `${cappedStem}${cappedExt}` || fallback;
}

async function safeDelete(engine, fileName) {
  try { await engine.deleteFile(fileName); } catch (_) {}
}

async function safeListDir(engine, dir = '/') {
  try {
    const entries = await engine.listDir(dir);
    return (entries || []).map((e) => String(e?.name || '')).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function serializeError(error) {
  if (error == null) return { message: 'Unknown error' };
  if (typeof error === 'string') {
    return { message: error, name: 'Error', stack: '' };
  }
  if (typeof error !== 'object') {
    return { message: String(error), name: 'Error', stack: '' };
  }
  const out = {
    message: error.message || String(error),
    name: error.name || 'Error',
    stack: error.stack || ''
  };
  try {
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key in out) continue;
      out[key] = error[key];
    }
  } catch (_) {}
  return out;
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== 'render') return;
  let stage = 'init';
  let op = '';
  let file = '';
  try {
    const engine = await ensureLoaded();
    recentLogs = [];
    const { videoBuffer, videoName, segments, fps, transitionMode, crossfadeSec, preserveAudio } = data.payload || {};
    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fpsNum = Math.max(1, Number(fps) || 30);
    const frameSec = 1 / fpsNum;
    if (!videoBuffer) throw new Error('Missing videoBuffer');
    if (!Array.isArray(segments) || !segments.length) throw new Error('No selected segments to render');

    const inputVideoName = `${runId}_${safeName(videoName, 'input.mp4')}`;
    const outputVideoName = `${runId}_out.mp4`;
    stage = 'fs';
    op = 'delete-input';
    file = inputVideoName;
    await safeDelete(engine, inputVideoName);
    op = 'delete-output';
    file = outputVideoName;
    await safeDelete(engine, outputVideoName);
    op = 'write-input';
    file = inputVideoName;
    await engine.writeFile(inputVideoName, new Uint8Array(videoBuffer));

    const inputArgs = ['-i', inputVideoName];
    const tempFiles = [inputVideoName];
    const filterParts = [];

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const mediaKind = seg.mediaKind === 'video' ? 'video' : 'image';
      const mediaExt = mediaKind === 'video'
        ? getVideoExt(seg.mediaName || '')
        : getImageExt(seg.mediaName || '');
      const mediaFile = `${runId}_overlay_${i}.${mediaExt}`;
      tempFiles.push(mediaFile);
      op = 'delete-overlay';
      file = mediaFile;
      await safeDelete(engine, mediaFile);
      op = 'write-overlay';
      file = mediaFile;
      await engine.writeFile(mediaFile, new Uint8Array(seg.mediaBuffer));
      if (mediaKind === 'image') {
        inputArgs.push('-stream_loop', '-1', '-i', mediaFile);
      } else {
        inputArgs.push('-i', mediaFile);
      }
      const segStart = Math.max(0, Number(seg.startSec) || 0);
      const segEndInclusive = Math.max(segStart, Number(seg.endSec) || segStart);
      const segEndExclusive = segEndInclusive + frameSec;
      const segDur = Math.max(0.01, segEndExclusive - segStart);
      const vw = Number(seg.videoWidth) || 1920;
      const vh = Number(seg.videoHeight) || 1080;
      const wPx = Math.max(2, Math.round(vw * ((Number(seg.widthPercent) || 0.1) / 100)));
      const hPx = Math.max(2, Math.round(vh * ((Number(seg.heightPercent) || 0.1) / 100)));
      const cxPx = Math.round(vw * ((Number(seg.xPercent) || 0) / 100));
      const cyPx = Math.round(vh * ((Number(seg.yPercent) || 0) / 100));
      const xPx = Math.round(cxPx - (wPx / 2));
      const yPx = Math.round(cyPx - (hPx / 2));
      const overlayTrim = mediaKind === 'video'
        ? `[${i + 1}:v]trim=start=0:end=${segDur},setpts=PTS-STARTPTS`
        : `[${i + 1}:v]trim=duration=${segDur},setpts=PTS-STARTPTS`;
      filterParts.push(
        `[0:v]trim=start=${segStart}:end=${segEndExclusive},setpts=PTS-STARTPTS[base${i}]`,
        `${overlayTrim},scale=${wPx}:${hPx}:force_original_aspect_ratio=decrease,format=rgba,pad=${wPx}:${hPx}:(ow-iw)/2:(oh-ih)/2:color=black@0[ov${i}]`,
        `[base${i}][ov${i}]overlay=${xPx}:${yPx}:eof_action=pass[vseg${i}]`
      );
      if (preserveAudio) {
        filterParts.push(`[0:a]atrim=start=${segStart}:end=${segEndExclusive},asetpts=PTS-STARTPTS[aseg${i}]`);
      }
    }

    const mode = transitionMode === 'xfade' ? 'xfade' : 'cut';
    const xfade = Math.max(0.05, Number(crossfadeSec) || 0.2);

    const vInputs = [];
    const aInputs = [];
    for (let i = 0; i < segments.length; i += 1) {
      vInputs.push(`[vseg${i}]`);
      if (preserveAudio) aInputs.push(`[aseg${i}]`);
    }

    let videoMap = '';
    let audioMap = '';

    if (segments.length === 1) {
      videoMap = '[vseg0]';
      if (preserveAudio) audioMap = '[aseg0]';
    } else if (mode === 'cut') {
      if (preserveAudio) {
        const concatInputs = [];
        for (let i = 0; i < segments.length; i += 1) {
          concatInputs.push(`[vseg${i}]`, `[aseg${i}]`);
        }
        filterParts.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
        videoMap = '[vcat]';
        audioMap = '[acat]';
      } else {
        filterParts.push(`${vInputs.join('')}concat=n=${segments.length}:v=1:a=0[vcat]`);
        videoMap = '[vcat]';
      }
    } else {
      let accDur = Math.max(0.01, (Math.max(Number(segments[0].startSec) || 0, Number(segments[0].endSec) || 0) + frameSec) - Math.max(0, Number(segments[0].startSec) || 0));
      let prevV = 'vseg0';
      let prevA = preserveAudio ? 'aseg0' : '';
      for (let i = 1; i < segments.length; i += 1) {
        const s = Math.max(0, Number(segments[i].startSec) || 0);
        const e = Math.max(s, Number(segments[i].endSec) || s) + frameSec;
        const curDur = Math.max(0.01, e - s);
        const d = Math.max(0.01, Math.min(xfade, (accDur - 0.01), (curDur - 0.01)));
        const offset = Math.max(0, accDur - d);
        const outV = `vx${i}`;
        filterParts.push(`[${prevV}][vseg${i}]xfade=transition=fade:duration=${d}:offset=${offset}[${outV}]`);
        prevV = outV;
        if (preserveAudio) {
          const outA = `ax${i}`;
          filterParts.push(`[${prevA}][aseg${i}]acrossfade=d=${d}[${outA}]`);
          prevA = outA;
        }
        accDur = Math.max(0.01, accDur + curDur - d);
      }
      videoMap = `[${prevV}]`;
      if (preserveAudio) audioMap = `[${prevA}]`;
    }

    const buildCommand = (withAudio) => {
      const args = [
        ...inputArgs,
        '-filter_complex',
        filterParts.join(';'),
        '-map',
        videoMap,
        '-r',
        String(fpsNum),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '21',
        '-pix_fmt',
        'yuv420p'
      ];
      if (withAudio && audioMap) {
        args.push('-map', audioMap, '-c:a', 'aac', '-b:a', '192k');
      } else {
        args.push('-an');
      }
      args.push(outputVideoName);
      return args;
    };

    try {
      stage = 'ffmpeg-exec';
      op = 'exec-main';
      file = outputVideoName;
      await engine.exec(buildCommand(!!preserveAudio));
    } catch (error) {
      if (!preserveAudio) throw error;
      op = 'exec-fallback-noaudio';
      await engine.exec(buildCommand(false));
    }
    // Free up MEMFS pressure before reading final output into JS memory.
    stage = 'fs';
    op = 'cleanup-temp-before-read';
    for (const temp of tempFiles) {
      file = temp;
      await safeDelete(engine, temp);
    }

    stage = 'fs';
    op = 'read-output';
    file = outputVideoName;
    const out = await engine.readFile(outputVideoName);
    const outBuffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    self.postMessage({ type: 'done', buffer: outBuffer }, [outBuffer]);
    await safeDelete(engine, outputVideoName);
  } catch (error) {
    const details = serializeError(error);
    details.stage = stage;
    details.op = op;
    details.file = file;
    details.recentLogs = recentLogs.slice(-40);
    let fsRoot = [];
    try {
      const engine = ffmpeg;
      if (engine) {
        fsRoot = await safeListDir(engine, '/');
        details.fsRoot = fsRoot;
      }
    } catch (_) {}
    if (details.op === 'read-output' && details.file) {
      details.outputExists = Array.isArray(fsRoot) ? fsRoot.includes(String(details.file)) : undefined;
    }
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      details
    });
  }
};
