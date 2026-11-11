import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { createBrain } from '../src/brain.js';
import { createApp, createJarvis } from '../src/app.js';

/** Cliente falso do Claude: devolve respostas roteirizadas e guarda as requisições. */
export function fakeClaude(script) {
  const requests = [];
  const queue = [...script];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(structuredClone(req));
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
    ...env,
  });
  const store = openStore(':memory:', { now: () => clock });
  const sent = [];
  const whatsapp = {
    live: false,
    sendText: async (to, text) => void sent.push({ to, text }),
    sendTemplate: async (to, name, lang, text) => void sent.push({ to, text, template: name }),
    sendAudio: async (to, buffer) => void sent.push({ to, audio: buffer }),
    downloadMedia: async () => ({ buffer: Buffer.from('ogg'), mime: 'audio/ogg' }),
    verifySignature: () => true,
  };
  const sp = speech ?? { enabled: false };
  const client = fakeClaude(script);
  const links = {};
  const quiet = () => {};
  const brain = createBrain({
    store, config, client, log: quiet,
    notifyOwner: (t) => links.jarvis.notifyOwner(t),
    sendToContact: (to, t) => whatsapp.sendText(to, t),
  });
  const jarvis = createJarvis({ store, config, whatsapp, speech: sp, brain, log: quiet });
  links.jarvis = jarvis;
  const app = createApp({ store, config, whatsapp, brain, jarvis, log: quiet });
  return { config, store, sent, whatsapp, client, brain, jarvis, app, advance: (ms) => (clock += ms) };
}

export async function serve(app) {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
