import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeWav } from './voiceprint.js';
import { modelReady } from './stt-worker.js';

const WORKER = fileURLToPath(new URL('./stt-worker.js', import.meta.url));
const MODEL_URL = (name) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-${name}.tar.bz2`;
const forkWorker = () => fork(WORKER, { serialization: 'advanced', execArgv: [], env: { ...process.env, JARVIS_STT_WORKER: '1' } });

/**
 * Transcrição no próprio servidor, com o Whisper (o mesmo motor do Vibe Local), sem serviço pago.
 * O modelo é baixado uma vez para o disco. A transcrição roda num processo à parte, criado na primeira
 * fala e encerrado depois de alguns minutos sem uso: a memória só fica ocupada enquanto há conversa.
 * Devolve null quando está desligada ou a biblioteca não existe nesta máquina.
 */
export function createLocalStt({ config, log = console.error, spawn = forkWorker, ready = modelReady }) {
  const name = config.localStt;
  if (!name) return null;
  try { createRequire(import.meta.url).resolve('sherpa-onnx-node'); } catch { log('[jarvis] transcrição local indisponível: biblioteca de voz não instalada'); return null; }
  const dir = config.localSttDir;
  let worker = null, idle = null, seq = 0, preparing = null, failed = null;
  const waiting = new Map();

  const stop = () => { clearTimeout(idle); if (worker) { worker.removeAllListeners(); worker.kill(); worker = null; } };
  const rejectAll = (why) => { for (const w of waiting.values()) w.reject(new Error(why)); waiting.clear(); };
  function getWorker() {
    if (worker) return worker;
    worker = spawn();
    worker.on('message', (m) => {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error)) : w.resolve(m.text);
    });
    worker.on('exit', () => { worker = null; rejectAll('o processo de transcrição parou'); });
    worker.on('error', (e) => { log('[jarvis] processo de transcrição:', e.message); });
    return worker;
  }

  return {
    name,
    /** O modelo já está no disco? Enquanto não estiver, quem chama usa outro caminho. */
    get ready() { return ready(dir, name); },
    status() { return { model: name, ready: ready(dir, name), running: Boolean(worker), error: failed }; },

    /** Baixa o modelo em segundo plano, num processo à parte, se ainda não estiver no disco. */
    prepare() {
      if (ready(dir, name) || preparing) return preparing ?? Promise.resolve();
      log(`[jarvis] baixando o modelo de transcrição local "${name}" (só na primeira vez)…`);
      preparing = new Promise((resolve) => {
        const p = spawn();
        const done = (error) => { p.removeAllListeners(); p.kill(); preparing = null; failed = error || null; log(error ? `[jarvis] modelo de transcrição local não baixou: ${error}` : '[jarvis] transcrição local pronta'); resolve(); };
        p.on('message', (m) => m.cmd === 'prepared' && done(m.error));
        p.on('exit', () => done('o download parou'));
        p.on('error', (e) => done(e.message));
        p.send({ cmd: 'prepare', url: MODEL_URL(name), dir, name });
      });
      return preparing;
    },

    /** WAV -> texto em português. */
    transcribe(wav) {
      if (!ready(dir, name)) return Promise.reject(new Error('modelo de transcrição local ainda não está no disco'));
      const { samples, sampleRate } = decodeWav(wav);
      clearTimeout(idle);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        getWorker().send({ cmd: 'transcribe', id, dir, name, threads: config.localSttThreads, samples, sampleRate });
      }).finally(() => {
        if (!waiting.size) { idle = setTimeout(stop, config.localSttIdleMs); idle.unref?.(); }
      });
    },
    stop,
  };
}
