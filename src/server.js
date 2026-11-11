import { loadConfig, ensureToken } from './config.js';
import { openStore } from './store.js';
import { createWhatsApp } from './whatsapp.js';
import { createSpeech } from './speech.js';
import { createBrain } from './brain.js';
import { createApp, createJarvis } from './app.js';
import { startScheduler } from './briefing.js';

const config = loadConfig();
ensureToken(config);

const store = openStore(config.dbPath);
const whatsapp = createWhatsApp(config.whatsapp);
const speech = createSpeech(config.speech);

// O cérebro e o orquestrador dependem um do outro (avisar o dono / falar com contato).
const links = {};
const brain = createBrain({
  store,
  config,
  notifyOwner: (text, meta) => links.jarvis.notifyOwner(text, meta),
  sendToContact: (to, text) => whatsapp.sendText(to, text),
});
const jarvis = createJarvis({ store, config, whatsapp, speech, brain });
links.jarvis = jarvis;

const app = createApp({ store, config, whatsapp, brain, jarvis });
startScheduler({ store, config, notifyOwner: jarvis.notifyOwner });

app.listen(config.port, () => {
  console.log(`[jarvis] ${config.assistantName} no ar em http://localhost:${config.port}`);
  console.log(`[jarvis] WhatsApp: ${whatsapp.live ? 'conectado' : 'modo console (sem credenciais)'}`);
  console.log(`[jarvis] Áudios no WhatsApp: ${speech.enabled ? 'ligados' : 'desligados (sem OPENAI_API_KEY)'}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('[jarvis] ATENÇÃO: sem ANTHROPIC_API_KEY o Jarvis registra eventos e manda resumos, mas não conversa.');
  }
  console.log(`[jarvis] Resumo diário às ${config.briefingHour}h (${config.timezone})`);
});
