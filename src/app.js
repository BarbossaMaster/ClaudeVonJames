import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getRules } from './store.js';
import { snapshot, runBriefing } from './briefing.js';
import { parseWebhook } from './whatsapp.js';
import { money, samePhone, safeEqual, keyedQueue } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 3600 * 1000;
const EVENT_TYPES = ['new_member', 'sale', 'refund', 'cancellation', 'payment_failed', 'customer_message', 'other'];

export function createJarvis({ store, config, whatsapp, speech, brain, log = console.error }) {
  const queue = keyedQueue();
  const ownerPhone = config.whatsapp.owner;

  /** Fala com o dono pelo WhatsApp, usando template se a janela de 24h dele fechou. */
  async function notifyOwner(text) {
    if (!ownerPhone) return void log(`[jarvis] (OWNER_WHATSAPP não definido) aviso ao dono:\n${text}`);
    const windowOpen = store.now() - store.get('ownerWhatsAppTs', 0) < 23 * 3600 * 1000;
    if (!windowOpen && whatsapp.live && config.whatsapp.briefingTemplate) {
      return whatsapp.sendTemplate(ownerPhone, config.whatsapp.briefingTemplate, config.whatsapp.templateLang, text);
    }
    return whatsapp.sendText(ownerPhone, text);
  }

  /** Registra um evento do negócio; acima do limite do dono, avisa na hora. */
  async function ingestEvent(e) {
    const rules = getRules(store, config);
    const amount = Number(e.amount) > 0 ? Number(e.amount) : null;
    const big = amount !== null && amount >= rules.threshold;
    const needsDecision = big && e.type !== 'sale';
    const id = store.addEvent({
      type: e.type,
      source: e.source ?? 'api',
      contact: e.contact,
      contactName: e.contact_name,
      amount,
      currency: e.currency ?? rules.currency,
      summary: e.summary,
      status: needsDecision ? 'pending' : 'handled',
      urgency: big ? 'urgent' : 'normal',
    });
    if (big) {
      const label = { sale: 'Venda grande', refund: 'Pedido de reembolso', payment_failed: 'Pagamento falhou' }[e.type] ?? 'Evento';
      await notifyOwner(
        `${needsDecision ? '🚨' : '💰'} ${label} de ${money(amount, rules.currency)}.\n#${id} ${e.summary ?? ''}${e.contact_name ? `\nContato: ${e.contact_name}` : ''}`,
      );
      store.updateEvent(id, { notified: 1 });
    }
    return { id, alerted: big };
  }

  async function handleWhatsApp(msg) {
    if (store.alreadySeen(`wa:${msg.id}`)) return;
    const isOwner = samePhone(msg.from, ownerPhone);
    const key = isOwner ? 'owner' : msg.from;
    if (isOwner) store.set('ownerWhatsAppTs', store.now()); // reabre a janela de 24h do WhatsApp

    return queue(key, async () => {
      let text = msg.text;
      let spoken = false;

      if (msg.type === 'audio' && msg.audioId) {
        if (!speech.enabled) {
          return whatsapp.sendText(msg.from, 'Ainda não consigo ouvir áudios por aqui. Pode me escrever?');
        }
        try {
          const { buffer, mime } = await whatsapp.downloadMedia(msg.audioId);
          text = await speech.transcribe(buffer, mime);
          spoken = true;
        } catch (e) {
          log('[jarvis] falha ao transcrever áudio:', e.message);
          return whatsapp.sendText(msg.from, 'Não consegui ouvir esse áudio. Pode me escrever?');
        }
      }
      if (!text?.trim()) {
        return whatsapp.sendText(msg.from, 'Por enquanto só consigo ler texto e ouvir áudios. Pode me escrever?');
      }

      let reply;
      if (isOwner) {
        reply = await brain.owner(text, { channel: spoken ? 'voice' : 'whatsapp' });
      } else {
        const eventId = store.addEvent({
          type: 'customer_message',
          source: 'whatsapp',
          contact: msg.from,
          contactName: msg.name,
          summary: text.slice(0, 280),
          status: 'handled',
        });
        const r = await brain.contact(text, { contact: msg.from, contactName: msg.name });
        if (r.escalated) store.updateEvent(eventId, { status: 'escalated' });
        reply = r.reply;
      }

      // Áudio recebido, áudio devolvido (com texto de reserva se a síntese falhar).
      if (spoken && speech.enabled) {
        try {
          return await whatsapp.sendAudio(msg.from, await speech.speak(reply));
        } catch (e) {
          log('[jarvis] falha ao gerar áudio:', e.message);
        }
      }
      return whatsapp.sendText(msg.from, reply);
    });
  }

  return { notifyOwner, ingestEvent, handleWhatsApp };
}

export function createApp({ store, config, whatsapp, brain, jarvis, log = console.error }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => (req.rawBody = buf) }));

  const auth = (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-jarvis-token');
    if (!safeEqual(token, config.token)) return res.status(401).json({ error: 'token inválido' });
    next();
  };
  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
      log('[jarvis] erro na rota:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'erro interno' });
    });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // --- WhatsApp (Meta Cloud API) ---
  app.get('/webhooks/whatsapp', (req, res) => {
    const ok =
      req.query['hub.mode'] === 'subscribe' &&
      safeEqual(req.query['hub.verify_token'], config.whatsapp.verifyToken);
    return ok ? res.status(200).send(String(req.query['hub.challenge'] ?? '')) : res.sendStatus(403);
  });

  app.post('/webhooks/whatsapp', (req, res) => {
    if (!whatsapp.verifySignature(req.rawBody ?? Buffer.alloc(0), req.get('x-hub-signature-256'))) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // a Meta exige resposta rápida; o processamento segue em segundo plano
    for (const msg of parseWebhook(req.body)) {
      jarvis.handleWhatsApp(msg).catch((e) => log('[jarvis] erro ao tratar mensagem:', e.message));
    }
  });

  // --- App de voz / texto do dono ---
  app.post(
    '/api/chat',
    auth,
    wrap(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'text é obrigatório' });
      const channel = req.body?.channel === 'voice' ? 'voice' : 'text';
      res.json({ reply: await brain.owner(text.slice(0, 4000), { channel }) });
    }),
  );

  app.get('/api/state', auth, (_req, res) => {
    res.json({
      assistant: config.assistantName,
      rules: getRules(store, config),
      today: snapshot(store, config, store.now() - DAY),
      whatsappLive: whatsapp.live,
    });
  });

  // --- Eventos do negócio (Stripe, Hotmart, Kiwify, Zapier, Make etc. apontam para cá) ---
  app.post(
    '/api/events',
    auth,
    wrap(async (req, res) => {
      const b = req.body ?? {};
      if (!EVENT_TYPES.includes(b.type)) {
        return res.status(400).json({ error: `type deve ser um de: ${EVENT_TYPES.join(', ')}` });
      }
      res.status(201).json(await jarvis.ingestEvent(b));
    }),
  );

  app.post(
    '/api/briefing',
    auth,
    wrap(async (_req, res) => {
      const text = await runBriefing({ store, config, notifyOwner: jarvis.notifyOwner, force: true });
      res.json({ sent: true, text });
    }),
  );

  app.use(express.static(join(here, '..', 'public')));
  return app;
}
