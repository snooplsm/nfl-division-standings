let ffmpeg = null;
let ffmpegReadyPromise = null;
let frameCount = 0;
let runId = 'run';
import { FFmpeg } from '@ffmpeg/ffmpeg';
const classWorkerURL = new URL('../ffmpeg/ffmpeg-class-worker.js', self.location.href).href;
const coreURL = new URL('../ffmpeg/ffmpeg-core.js', self.location.href).href;
const wasmURL = new URL('../ffmpeg/ffmpeg-core.wasm', self.location.href).href;

async function safeDelete(engine, fileName) {
  try { await engine.deleteFile(fileName); } catch (_) {}
}

async function ensureLoaded() {
  if (ffmpegReadyPromise) {
    self.postMessage({ type: 'status', stage: 'awaiting-existing-load' });
    await ffmpegReadyPromise;
    return ffmpeg;
  }
  ffmpegReadyPromise = (async () => {
    self.postMessage({ type: 'status', stage: 'creating-ffmpeg-instance' });
    ffmpeg = new FFmpeg();
    self.postMessage({
      type: 'status',
      stage: 'starting-ffmpeg-load',
      details: { classWorkerURL, coreURL, wasmURL }
    });
    await ffmpeg.load({
      classWorkerURL,
      coreURL,
      wasmURL
    });
    self.postMessage({ type: 'status', stage: 'ffmpeg-loaded' });
    ffmpeg.on('progress', ({ progress }) => {
      self.postMessage({ type: 'progress', progress });
    });
    self.postMessage({ type: 'ready' });
  })();
  await ffmpegReadyPromise;
  return ffmpeg;
}

self.onmessage = async (event) => {
  const { type, index, buffer, fps } = event.data || {};
  self.postMessage({ type: 'status', stage: `message-${type || 'unknown'}-received` });
  try {
    const engine = await ensureLoaded();
    if (type === 'init') {
      frameCount = 0;
      runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return;
    }
    if (type === 'frame') {
      const name = `${runId}_frame_${String(index).padStart(5, '0')}.png`;
      await safeDelete(engine, name);
      await engine.writeFile(name, new Uint8Array(buffer));
      frameCount += 1;
      return;
    }
    if (type === 'encode') {
      if (!frameCount) throw new Error('No frames to encode');
      const outputName = `${runId}_out.mp4`;
      await safeDelete(engine, outputName);
      await engine.exec([
        '-framerate',
        String(fps || 20),
        '-i',
        `${runId}_frame_%05d.png`,
        '-crf',
        '21',
        '-preset',
        'veryfast',
        '-filter_complex',
        '[0:v]split=2[f][r];[r]reverse[rr];[f][rr]concat=n=2:v=1:a=0,format=yuv420p[v]',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-map',
        '[v]',
        outputName
      ]);
      const out = await engine.readFile(outputName);
      const outBuffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      self.postMessage({ type: 'done', buffer: outBuffer }, [outBuffer]);
      return;
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
};
