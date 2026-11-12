import { createRequire } from 'node:module';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx';

export const cosine = (a, b) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
};

/** Lê um WAV PCM de 16 bits e devolve as amostras do primeiro canal como Float32 entre -1 e 1. */
export function decodeWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('áudio não é WAV');
  }
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4), size = buffer.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: buffer.readUInt16LE(pos + 8), channels: buffer.readUInt16LE(pos + 10), sampleRate: buffer.readUInt32LE(pos + 12), bits: buffer.readUInt16LE(pos + 22) };
    if (id === 'data') { data = buffer.subarray(pos + 8, Math.min(buffer.length, pos + 8 + size)); break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) throw new Error('WAV precisa ser PCM de 16 bits');
  const frames = Math.floor(data.length / 2 / fmt.channels), samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  return { samples, sampleRate: fmt.sampleRate, seconds: frames / fmt.sampleRate };
}

/** Carrega o modelo de voz (baixando na primeira vez). Devolve uma função samples -> vetor, ou lança erro. */
export async function loadEmbedder({ modelPath, fetchImpl = fetch, log = console.log }) {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  if (!existsSync(modelPath) || statSync(modelPath).size < 1_000_000) {
    log('[jarvis] baixando o modelo de reconhecimento de voz (40 MB, só na primeira vez)…');
    mkdirSync(dirname(modelPath), { recursive: true });
    const res = await fetchImpl(MODEL_URL);
    if (!res.ok) throw new Error(`download do modelo de voz falhou (${res.status})`);
    writeFileSync(modelPath + '.part', Buffer.from(await res.arrayBuffer()));
    renameSync(modelPath + '.part', modelPath);
  }
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false });
  return (samples, sampleRate) => {
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate, samples });
    stream.inputFinished();
    return Array.from(extractor.compute(stream, false));
  };
}

/**
 * Impressões vocais: uma por pessoa autorizada, guardadas no banco como a média das amostras gravadas.
 * Serve para o assistente saber com quem fala. Não é trava de segurança: erra com ruído e vozes parecidas.
 */
export function createVoiceprints({ store, config, embedder = null, loader = loadEmbedder, log = console.error }) {
  let embed = embedder, loading = null, failed = null;
  const all = () => store.get('voiceprints', []);

  async function ready() {
    if (embed) return embed;
    if (failed) throw failed;
    loading ??= loader({ modelPath: config.voiceprintModel, log })
      .then((fn) => (embed = fn))
      .catch((e) => { failed = e; log('[jarvis] reconhecimento de voz indisponível:', e.message); throw e; });
    return loading;
  }

  return {
    /** Começa a carregar o modelo em segundo plano, para a primeira fala não esperar o download. */
    warm() { ready().catch(() => {}); },

    status() {
      return { available: !failed, loaded: Boolean(embed), threshold: config.voiceprintThreshold, people: all().map((p) => ({ name: p.name, samples: p.samples })) };
    },

    /** Acrescenta uma amostra de voz à pessoa. Devolve quantas amostras ela tem agora. */
    async enroll(name, wav) {
      const { samples, sampleRate, seconds } = decodeWav(wav);
      if (seconds < 3) throw new Error('gravação curta demais: fale por pelo menos três segundos');
      const vector = (await ready())(samples, sampleRate);
      const list = all();
      const key = String(name || 'dono').trim().toLowerCase().slice(0, 40) || 'dono';
      let p = list.find((x) => x.name === key);
      if (!p) list.push((p = { name: key, samples: 0, vector: vector.map(() => 0) }));
      p.vector = p.vector.map((v, i) => (v * p.samples + vector[i]) / (p.samples + 1));
      p.samples += 1;
      store.set('voiceprints', list);
      return { name: key, samples: p.samples };
    },

    remove(name) {
      const key = String(name ?? '').trim().toLowerCase();
      store.set('voiceprints', key ? all().filter((p) => p.name !== key) : []);
    },

    /** Compara a fala com as pessoas cadastradas. match só é true com nota acima do limite e fala de tamanho suficiente. */
    async identify(wav) {
      const list = all();
      if (!list.length) return { enrolled: false, available: !failed, match: false, name: null, score: null };
      try {
        const { samples, sampleRate, seconds } = decodeWav(wav);
        const vector = (await ready())(samples, sampleRate);
        let best = { name: null, score: -1 };
        for (const p of list) { const s = cosine(vector, p.vector); if (s > best.score) best = { name: p.name, score: s }; }
        const short = seconds < 1.2; // fala curta demais dá nota instável
        return { enrolled: true, available: true, match: best.score >= config.voiceprintThreshold, short, name: best.name, score: Math.round(best.score * 100) / 100 };
      } catch (e) {
        return { enrolled: true, available: false, match: false, name: null, score: null, error: e.message };
      }
    },
  };
}
