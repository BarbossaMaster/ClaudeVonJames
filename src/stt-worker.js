/**
 * Processo à parte para a transcrição local (Whisper). Fica separado do servidor por dois motivos:
 * transcrever ocupa o processador por alguns segundos, e o modelo ocupa centenas de MB de memória.
 * O servidor encerra este processo depois de um tempo sem uso, e a memória volta inteira.
 *
 * Mensagens: { cmd: 'prepare', url, dir, name }  baixa o modelo se faltar
 *            { cmd: 'transcribe', id, dir, name, threads, samples, sampleRate }
 */
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
export const modelFiles = (dir, name) => ({
  encoder: join(dir, `${name}-encoder.int8.onnx`),
  decoder: join(dir, `${name}-decoder.int8.onnx`),
  tokens: join(dir, `${name}-tokens.txt`),
});
export const modelReady = (dir, name) => Object.values(modelFiles(dir, name)).every((f) => existsSync(f) && statSync(f).size > 100_000);

/** Baixa o pacote do modelo e guarda só os três arquivos usados (versão compacta, int8). */
export async function downloadModel({ url, dir, name, fetchImpl = fetch }) {
  if (modelReady(dir, name)) return;
  mkdirSync(dir, { recursive: true });
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`download do modelo de transcrição falhou (${res.status})`);
  const wanted = new Set(Object.values(modelFiles(dir, name)).map((f) => basename(f)));
  const extract = require('tar-stream').extract();
  const written = [];
  extract.on('entry', (header, stream, next) => {
    const file = basename(header.name);
    if (header.type !== 'file' || !wanted.has(file)) { stream.on('end', next); return stream.resume(); }
    const part = join(dir, file + '.part');
    pipeline(stream, createWriteStream(part)).then(() => { written.push(file); next(); }, next);
  });
  try {
    await pipeline(Readable.fromWeb(res.body), require('unbzip2-stream')(), extract);
    if (written.length !== wanted.size) throw new Error('pacote do modelo veio incompleto');
    for (const f of written) renameSync(join(dir, f + '.part'), join(dir, f));
  } catch (e) {
    for (const f of wanted) rmSync(join(dir, f + '.part'), { force: true });
    throw e;
  }
}

const MAX_S = 25; // o Whisper lê até 30 s por vez: fala mais longa é cortada em trechos, na pausa mais quieta

/** Divide a fala em trechos de até 25 s, cortando no ponto mais silencioso dos últimos 5 s de cada trecho. */
export function splitSamples(samples, sampleRate, maxS = MAX_S) {
  const max = Math.floor(maxS * sampleRate), win = Math.floor(0.3 * sampleRate), out = [];
  let start = 0;
  while (samples.length - start > max) {
    const from = start + max - 5 * sampleRate, to = start + max - win;
    let best = to, low = Infinity;
    for (let i = Math.max(start + win, from); i <= to; i += Math.floor(win / 3)) {
      let e = 0;
      for (let j = i; j < i + win; j++) e += samples[j] * samples[j];
      if (e < low) { low = e; best = i + Math.floor(win / 2); }
    }
    out.push(samples.subarray(start, best));
    start = best;
  }
  out.push(samples.subarray(start));
  return out;
}

// Frases que o Whisper costuma inventar em trecho de silêncio ou ruído.
const GHOST = /legendas? (pela|da) comunidade|amara\.org|^\W*(obrigad[oa]\.?|tchau\.?)\W*$/i;
export const cleanText = (t) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return GHOST.test(s) ? '' : s; };

let recognizer = null, loaded = '';
function transcribe({ dir, name, threads, samples, sampleRate }) {
  const sherpa = require('sherpa-onnx-node');
  if (loaded !== `${dir}/${name}`) {
    const f = modelFiles(dir, name);
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { whisper: { encoder: f.encoder, decoder: f.decoder, language: 'pt', task: 'transcribe' }, tokens: f.tokens, numThreads: threads, provider: 'cpu', debug: 0 },
    });
    loaded = `${dir}/${name}`;
  }
  const parts = [];
  for (const chunk of splitSamples(samples, sampleRate)) {
    if (chunk.length < sampleRate * 0.2) continue;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples: chunk });
    recognizer.decode(stream);
    const text = cleanText(recognizer.getResult(stream).text);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

if (process.send && process.env.JARVIS_STT_WORKER === '1') {
  process.on('message', async (m) => {
    try {
      if (m.cmd === 'prepare') { await downloadModel(m); process.send({ cmd: 'prepared' }); }
      if (m.cmd === 'transcribe') process.send({ id: m.id, text: transcribe(m) });
    } catch (e) {
      process.send(m.cmd === 'prepare' ? { cmd: 'prepared', error: e.message } : { id: m.id, error: e.message });
    }
  });
  process.on('disconnect', () => process.exit(0));
}
