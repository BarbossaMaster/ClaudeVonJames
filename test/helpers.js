import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { createBrain } from '../src/brain.js';
import { createApp, createJarvis } from '../src/app.js';
import { createDocuments } from '../src/documents.js';
import { createVoiceprints } from '../src/voiceprint.js';
import { createFiles } from '../src/files.js';
import { createAgenda } from '../src/agenda.js';
import { createReminders } from '../src/reminders.js';
import { createMailing } from '../src/mailing.js';

/** Cliente falso do Claude: devolve respostas roteirizadas e guarda as requisições. */
export function fakeClaude(script) {
  const requests = [];
  const queue = [...script];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          const seen = structuredClone(req);
          if (Array.isArray(seen.system)) seen.system = seen.system.map((b) => b.text).join(''); // os testes leem o texto
          for (const m of seen.messages) if (Array.isArray(m.content) && m.content.length === 1 && m.content[0].type === 'text') m.content = m.content[0].text;
          requests.push(seen);
          const next = queue.shift();
          if (!next) throw new Error('roteiro do Claude falso acabou');
          return typeof next === 'function' ? next(req) : next;
        },
      },
    },
  };
}
export const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
export const use = (name, input, id = 'tu_' + name) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
});

export function setup({ script = [], env = {}, speech } = {}) {
  let clock = Date.UTC(2026, 10, 11, 15, 0, 0); // 12h em São Paulo
  const config = loadConfig({
    JARVIS_TOKEN: 'segredo',
    OWNER_WHATSAPP: '+55 (11) 98888-7777',
    WHATSAPP_VERIFY_TOKEN: 'verifica',
    KNOWLEDGE_DIR: '/nonexistent',
    JARVIS_SERVER_LISTEN: '1',
    JARVIS_ROUTER: 'off',
    JARVIS_WEB: 'off', // a busca na internet é testada à parte
 // a troca automática de modelo é testada à parte

    ...env,
  });
  const store = openStore(':memory:', { now: () => clock });
  const sent = [];
  const whatsapp = {
    live: false,
    sendText: async (to, text) => void sent.push({ to, text }),
    sendTemplate: async (to, name, lang, text) => void sent.push({ to, text, template: name }),
    sendAudio: async (to, buffer) => void sent.push({ to, audio: buffer }),
    sendDocument: async (to, buffer, filename, caption) => void sent.push({ to, document: buffer, filename, caption }),
    downloadMedia: async () => ({ buffer: Buffer.from('ogg'), mime: 'audio/ogg' }),
    verifySignature: () => true,
  };
  const sp = speech ?? { enabled: false };
  const client = fakeClaude(script);
  const documents = createDocuments({ store, config, dir: ':memory:' });
  // Modelo de voz falso: o 'vetor' é o primeiro valor do áudio repetido, o que basta para simular vozes diferentes.
  const files = createFiles({ store });
  const agenda = createAgenda({ store, config });
  const reminders = createReminders({ store });
  const mailing = createMailing({ store });
  const voiceprints = createVoiceprints({ store, config, embedder: (samples) => [Math.round(samples[0] * 10), 1, 0] });
  const links = {};
  const quiet = () => {};
  const brain = createBrain({
    store, config, client, log: quiet,
    notifyOwner: (t) => links.jarvis.notifyOwner(t),
    sendToContact: (to, t) => whatsapp.sendText(to, t),
    documents,
    sendDocumentToOwner: (doc) => links.jarvis.sendDocumentToOwner(doc),
    files,
    agenda,
    reminders,
    mailing,
  });
  const jarvis = createJarvis({ store, config, whatsapp, speech: sp, brain, log: quiet });
  links.jarvis = jarvis;
  const app = createApp({ store, config, whatsapp, speech: sp, brain, jarvis, documents, voiceprints, files, agenda, reminders, mailing, log: quiet });
  return { config, store, sent, whatsapp, client, brain, jarvis, app, documents, voiceprints, files, agenda, reminders, mailing, advance: (ms) => (clock += ms) };
}

export async function serve(app) {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
