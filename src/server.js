import { loadConfig, ensureToken } from './config.js';
import { openStore } from './store.js';
import { createWhatsApp } from './whatsapp.js';
import { createSpeech } from './speech.js';
import { createBrain } from './brain.js';
import { createApp, createJarvis } from './app.js';
import { startScheduler } from './briefing.js';
import { createDocuments } from './documents.js';
import { createVoiceprints } from './voiceprint.js';
import { createFiles } from './files.js';
import { createAgenda } from './agenda.js';
import { createReminders } from './reminders.js';
import { createMailing } from './mailing.js';
import { dirname, join } from 'node:path';

const config = loadConfig();
ensureToken(config);

const store = openStore(config.dbPath);
const whatsapp = createWhatsApp(config.whatsapp);
const speech = createSpeech(config.speech);

// O cérebro e o orquestrador dependem um do outro (avisar o dono / falar com contato).
const documents = createDocuments({
  store,
  config,
  dir: config.dbPath === ':memory:' ? ':memory:' : join(dirname(config.dbPath), 'docs'),
});
const voiceprints = createVoiceprints({ store, config });
const files = createFiles({ store });
const agenda = createAgenda({ store, config });
const reminders = createReminders({ store });
const mailing = createMailing({ store });
if (speech.enabled && config.serverListen) voiceprints.warm();
const links = {};
const brain = createBrain({
  store,
  config,
  notifyOwner: (text, meta) => links.jarvis.notifyOwner(text, meta),
  sendToContact: (to, text) => whatsapp.sendText(to, text),
  documents,
  sendDocumentToOwner: (doc) => links.jarvis.sendDocumentToOwner(doc),
  files,
  agenda,
  reminders,
  mailing,
});
const jarvis = createJarvis({ store, config, whatsapp, speech, brain });
links.jarvis = jarvis;

const app = createApp({ store, config, whatsapp, speech, brain, jarvis, documents, voiceprints, files, agenda, reminders, mailing });
startScheduler({ store, config, notifyOwner: jarvis.notifyOwner, agenda, reminders, mailing });

app.listen(config.port, () => {
  console.log(`[jarvis] ${config.assistantName} no ar em http://localhost:${config.port}`);
  console.log(`[jarvis] WhatsApp: ${whatsapp.live ? 'conectado' : 'modo console (sem credenciais)'}`);
  console.log(`[jarvis] Voz: ${speech.canSpeak ? speech.provider : 'do navegador (sem ELEVENLABS_API_KEY/OPENAI_API_KEY)'}`);
  console.log(`[jarvis] Escuta (transcrição): ${speech.enabled ? speech.listener : 'do navegador (sem chave de transcrição)'}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('[jarvis] ATENÇÃO: sem ANTHROPIC_API_KEY o Jarvis registra eventos e manda resumos, mas não conversa.');
  }
  console.log(`[jarvis] Resumo diário às ${config.briefingHour}h (${config.timezone})`);
});
