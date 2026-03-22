import { FFmpeg } from '@ffmpeg/ffmpeg';

let ffmpeg = null;
let ffmpegReadyPromise = null;
let frameCount = 0;
let runId = 'run';
const ENCODE_CRF = '30';

async function safeDelete(engine, fileName) {
  try { await engine.deleteFile(fileName); } catch (_) {}
}

async function encodePngRangeToWebm(engine, {
  runId,
  outputName,
  fps,
  startNumber,
  frames
}) {
  await engine.exec([
    '-framerate',
    String(Math.max(1, Number(fps) || 12)),
    '-start_number',
    String(Math.max(0, Number(startNumber) || 0)),
    '-i',
    `${runId}_frame_%05d.png`,
    '-frames:v',
    String(Math.max(1, Number(frames) || 1)),
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-b:v',
    '0',
    '-crf',
    ENCODE_CRF,
    outputName
  ]);
}

async function concatWebmChunks(engine, chunkNames, outputName) {
  if (!chunkNames.length) {
    throw new Error('No chunks to concat');
  }
  if (chunkNames.length === 1) {
    await engine.exec([
      '-i',
      chunkNames[0],
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-auto-alt-ref',
      '0',
      '-b:v',
      '0',
      '-crf',
      ENCODE_CRF,
      outputName
    ]);
    return;
  }

  const inputArgs = [];
  const concatInputs = [];
  for (let i = 0; i < chunkNames.length; i += 1) {
    inputArgs.push('-i', chunkNames[i]);
    concatInputs.push(`[${i}:v]`);
  }
  await engine.exec([
    ...inputArgs,
    '-filter_complex',
    `${concatInputs.join('')}concat=n=${chunkNames.length}:v=1:a=0[v]`,
    '-map',
    '[v]',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-b:v',
    '0',
    '-crf',
    ENCODE_CRF,
    outputName
  ]);
}

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
  })();
  await ffmpegReadyPromise;
  return ffmpeg;
}

self.onmessage = async (event) => {
  const { type, index, buffer, fps } = event.data || {};
  try {
    const engine = await ensureLoaded();
    if (type === 'start') {
      frameCount = 0;
      runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return;
    }
    if (type === 'frame') {
      const name = `${runId}_frame_${String(index).padStart(5, '0')}.png`;
      await safeDelete(engine, name);
      await engine.writeFile(name, new Uint8Array(buffer));
      frameCount += 1;
      self.postMessage({ type: 'frame-ack', index });
      return;
    }
    if (type === 'encode') {
      if (!frameCount) throw new Error('No frames to encode');
      const outputName = `${runId}_out.webm`;
      const chunkSize = Math.max(0, Number(event.data?.chunkSize) || 0);
      if (!chunkSize || frameCount <= chunkSize) {
        await safeDelete(engine, outputName);
        await encodePngRangeToWebm(engine, {
          runId,
          outputName,
          fps,
          startNumber: 0,
          frames: frameCount
        });
      } else {
        const chunks = [];
        const totalChunks = Math.ceil(frameCount / chunkSize);
        for (let c = 0; c < totalChunks; c += 1) {
          const start = c * chunkSize;
          const frames = Math.min(chunkSize, frameCount - start);
          const chunkName = `${runId}_chunk_${String(c).padStart(3, '0')}.webm`;
          await safeDelete(engine, chunkName);
          self.postMessage({ type: 'status', stage: 'chunk-encode', chunk: c + 1, totalChunks, frames });
          await encodePngRangeToWebm(engine, {
            runId,
            outputName: chunkName,
            fps,
            startNumber: start,
            frames
          });
          chunks.push(chunkName);
          for (let i = start; i < (start + frames); i += 1) {
            const frameName = `${runId}_frame_${String(i).padStart(5, '0')}.png`;
            try { await engine.deleteFile(frameName); } catch (_) {}
          }
        }
        self.postMessage({ type: 'status', stage: 'chunk-concat', totalChunks });
        await safeDelete(engine, outputName);
        await concatWebmChunks(engine, chunks, outputName);
      }
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
