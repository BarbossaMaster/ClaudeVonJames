import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getRules } from './store.js';
import { loadKnowledge } from './knowledge.js';
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
      if (spoken && speech.canSpeak) {
        try {
          const audio = await speech.speak(reply, { format: 'voice' });
          return await whatsapp.sendAudio(msg.from, audio.buffer, audio.mime);
        } catch (e) {
          log('[jarvis] falha ao gerar áudio:', e.message);
        }
      }
      return whatsapp.sendText(msg.from, reply);
    });
  }

  /** Manda um PDF ao WhatsApp do dono. Devolve uma frase com o que aconteceu, para o modelo relatar a verdade. */
  async function sendDocumentToOwner(doc) {
    if (!ownerPhone) return 'não enviado: o número do dono não está configurado';
    if (!whatsapp.live) return 'não enviado: o WhatsApp ainda não está conectado; o PDF está disponível no app';
    await whatsapp.sendDocument(ownerPhone, doc.buffer, doc.filename, doc.title);
    return 'enviado ao WhatsApp do dono';
  }

  return { notifyOwner, ingestEvent, handleWhatsApp, sendDocumentToOwner };
}

export function createApp({ store, config, whatsapp, speech, brain, jarvis, documents, voiceprints, files, agenda, reminders, mailing, log = console.error }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => (req.rawBody = buf) }));
  const fileBody = express.raw({ type: () => true, limit: '25mb' });
  const wavBody = express.raw({ type: ['audio/wav', 'audio/x-wav', 'audio/wave'], limit: '12mb' });

  // Momento em que o assistente ficou online pela primeira vez; fica gravado e nunca mais muda.
  const bornAt = () => {
    let ts = store.get('bornAt', 0);
    // Se já existiam conversas antes de esta contagem nascer, vale a data da primeira delas.
    const first = Math.min(ts || Infinity, store.earliest() ?? Infinity, store.now());
    if (first !== ts) { ts = first; store.set('bornAt', ts); }
    return ts;
  };
  bornAt();
  // Saberes: cada linha de conteúdo da base de conhecimento, cada fato ensinado e cada regra.
  // Memórias: cada fala guardada e cada acontecimento registrado.
  const knowledgeStats = () => {
    const facts = loadKnowledge(config.knowledgeDir, store)
      .split('\n')
      .filter((l) => { const t = l.trim(); return t.length > 3 && !/^(#|>|---)/.test(t); }).length;
    const c = store.counts();
    // Cada arquivo enviado conta como saber, na proporção do texto que tem (um a cada 400 caracteres).
    const fromFiles = files ? files.list().reduce((n, f) => n + Math.max(1, Math.round(f.chars / 400)), 0) : 0;
    return { saberes: facts + fromFiles + getRules(store, config).instructions.length, memorias: c.turns + c.events };
  };

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
    // Uma linha por entrega, para dar para ver no log o que chegou e o que aconteceu (números mascarados).
    const tail = (n) => '…' + String(n ?? '').slice(-4);
    const msgs = parseWebhook(req.body);
    const field = req.body?.entry?.[0]?.changes?.[0]?.field ?? '?';
    const statuses = req.body?.entry?.[0]?.changes?.[0]?.value?.statuses?.length ?? 0;
    // Avisos de status dizem o destino de cada resposta: sent, delivered, read ou failed (com o motivo).
    for (const st of req.body?.entry?.[0]?.changes?.[0]?.value?.statuses ?? []) {
      const err = st.errors?.[0];
      log(`[jarvis] WhatsApp: resposta a ${tail(st.recipient_id)} → ${st.status}${err ? ` · erro ${err.code}: ${err.title ?? ''} ${err.error_data?.details ?? err.message ?? ''}` : ''}`);
    }
    if (!msgs.length && !statuses) log(`[jarvis] WhatsApp: entrega sem mensagem (campo "${field}")`);
    for (const msg of msgs) {
      log(`[jarvis] WhatsApp: mensagem de ${tail(msg.from)} (${msg.type})${samePhone(msg.from, config.whatsapp.owner) ? ', reconhecido como dono' : ', tratado como contato'}`);
      jarvis
        .handleWhatsApp(msg)
        .then(() => log(`[jarvis] WhatsApp: resposta enviada a ${tail(msg.from)}`))
        .catch((e) => log('[jarvis] erro ao tratar mensagem:', e.message));
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
      const created = [];
      const meta = {};
      const screen = req.body?.screen && typeof req.body.screen === 'object' ? req.body.screen : null;
      const reply = await brain.owner(text.slice(0, 4000), { channel, documents: created, meta, screen });
      res.json({
        reply,
        documents: created,
        actions: meta.actions ?? [], // comandos de tela que o app executa com o feixe
        cues: meta.cues ?? [],       // gestos marcados dentro da fala, com a posição no texto
        model: meta.model,
        trace: { model: meta.model, ms: meta.ms, routeMs: meta.routeMs, steps: meta.steps, tools: meta.tools, tokensIn: meta.tokensIn, tokensOut: meta.tokensOut },
      });
    }),
  );

  // Escuta do app: recebe a fala gravada (WAV), transcreve e diz de quem é a voz.
  app.post(
    '/api/listen',
    auth,
    wavBody,
    wrap(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length < 2000) return res.status(400).json({ error: 'envie um áudio WAV' });
      if (!speech?.enabled) return res.status(503).json({ error: 'transcrição não configurada' });
      const t0 = Date.now();
      const [text, speaker] = await Promise.all([
        speech.transcribe(req.body, 'audio/wav'),
        voiceprints ? voiceprints.identify(req.body) : { enrolled: false, available: false, match: false },
      ]);
      res.json({ text, speaker, ms: Date.now() - t0 });
    }),
  );

  // Agenda: listar, marcar e desmarcar. O endereço /cal/<chave>.ics serve para assinar no calendário do celular.
  app.get('/api/agenda', auth, (req, res) => {
    res.json({ events: agenda ? agenda.upcoming(Math.min(365, Number(req.query.days) || 60)) : [], ics: agenda ? `/cal/${agenda.icsKey()}.ics` : null });
  });
  app.post('/api/agenda', auth, (req, res) => {
    if (!agenda) return res.status(503).json({ error: 'agenda indisponível' });
    try { res.status(201).json(agenda.add(req.body ?? {})); } catch (e) { res.status(422).json({ error: e.message }); }
  });
  app.delete('/api/agenda/:id', auth, (req, res) => {
    try { agenda.remove(req.params.id); } catch { /* já não existe */ }
    res.json({ events: agenda ? agenda.upcoming(60) : [] });
  });
  app.get('/cal/:file', (req, res) => {
    const key = String(req.params.file).replace(/\.ics$/i, '');
    if (!agenda || !safeEqual(key, agenda.icsKey())) return res.sendStatus(404);
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).send(agenda.ics());
  });

  // E-mail marketing (primeira parte): contatos e rascunhos. Ainda sem envio.
  const mailingView = () => ({ contacts: mailing ? mailing.contacts() : [], drafts: mailing ? mailing.drafts() : [], counts: mailing ? mailing.counts() : { total: 0 } });
  app.get('/api/mailing', auth, (_req, res) => res.json(mailingView()));
  app.post('/api/mailing/contacts', auth, (req, res) => {
    if (!mailing) return res.status(503).json({ error: 'lista de e-mail indisponível' });
    try {
      const b = req.body ?? {};
      const imported = b.lines !== undefined ? mailing.importLines(b.lines) : (mailing.addContact(b), { added: 1, failed: [] });
      res.status(201).json({ ...imported, ...mailingView() });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });
  app.delete('/api/mailing/contacts/:id', auth, (req, res) => { mailing?.removeContact(req.params.id); res.json(mailingView()); });
  app.delete('/api/mailing/drafts/:id', auth, (req, res) => { mailing?.removeDraft(req.params.id); res.json(mailingView()); });

  // Arquivos do dono: enviar (o corpo é o próprio arquivo; o nome vem no cabeçalho x-filename), listar e apagar.
  // Ficam só no modo dono: o atendimento a clientes não enxerga esse material.
  app.get('/api/files', auth, (_req, res) => res.json({ files: files ? files.list() : [] }));
  app.post(
    '/api/files',
    auth,
    fileBody,
    wrap(async (req, res) => {
      if (!files) return res.status(503).json({ error: 'arquivos indisponíveis' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'arquivo vazio' });
      let name = 'arquivo';
      try { name = decodeURIComponent(req.get('x-filename') || 'arquivo'); } catch { /* nome ilegível: usa o padrão */ }
      try {
        res.status(201).json(await files.add(req.body, name, req.get('x-filetype') || req.get('content-type') || ''));
      } catch (e) {
        res.status(422).json({ error: e.message });
      }
    }),
  );
  app.delete('/api/files/:id', auth, (req, res) => {
    files?.remove(req.params.id);
    res.json({ files: files ? files.list() : [] });
  });

  // Impressão vocal: gravar amostras, consultar e apagar.
  app.get('/api/voiceprint', auth, (_req, res) => res.json(voiceprints ? voiceprints.status() : { available: false, people: [] }));
  app.post(
    '/api/voiceprint',
    auth,
    wavBody,
    wrap(async (req, res) => {
      if (!voiceprints) return res.status(503).json({ error: 'reconhecimento de voz indisponível' });
      if (!Buffer.isBuffer(req.body) || req.body.length < 2000) return res.status(400).json({ error: 'envie um áudio WAV' });
      try {
        res.status(201).json({ ...(await voiceprints.enroll(req.query.name, req.body)), ...voiceprints.status() });
      } catch (e) {
        res.status(422).json({ error: e.message });
      }
    }),
  );
  app.delete('/api/voiceprint', auth, (req, res) => {
    voiceprints?.remove(req.query.name);
    res.json(voiceprints ? voiceprints.status() : { available: false, people: [] });
  });

  // Voz natural para o app: devolve MP3 da resposta.
  app.post(
    '/api/speak',
    auth,
    wrap(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'text é obrigatório' });
      if (!speech?.canSpeak) return res.status(503).json({ error: 'voz não configurada' });
      // Com timed=true, tenta a fala com o tempo de cada letra (para sincronizar gestos); se não der, manda só o áudio.
      if (req.body?.timed && speech.speakTimed) {
        try {
          const timed = await speech.speakTimed(text.slice(0, 2000));
          if (timed) return res.set('Cache-Control', 'no-store').json(timed);
        } catch (e) {
          log('[jarvis] fala com tempos indisponível, usando a fala comum:', e.message);
        }
      }
      const audio = await speech.speak(text.slice(0, 2000), { format: 'mp3' });
      res.set({ 'Content-Type': audio.mime, 'Cache-Control': 'no-store' }).send(audio.buffer);
    }),
  );

  // Documentos gerados. O endereço /d/<id>.pdf funciona como chave: só abre quem recebeu o link.
  app.get('/api/docs', auth, (_req, res) => res.json({ documents: documents ? documents.list() : [] }));
  app.get('/d/:file', (req, res) => {
    const id = String(req.params.file).replace(/\.pdf$/i, '');
    const doc = /^[\w-]{16,}$/.test(id) && documents ? documents.read(id) : null;
    if (!doc) return res.sendStatus(404);
    res
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${doc.filename}"`,
        'Cache-Control': 'private, max-age=3600',
        'X-Robots-Tag': 'noindex',
      })
      .send(doc.buffer);
  });

  app.get('/api/state', auth, (_req, res) => {
    res.json({
      assistant: config.assistantName,
      business: config.businessName,
      now: store.now(),
      rules: getRules(store, config),
      today: snapshot(store, config, store.now() - DAY),
      whatsappLive: whatsapp.live,
      voice: Boolean(speech?.canSpeak),
      voiceRate: config.voiceRate,
      // Dados do "esqueleto" para o painel do app.
      system: {
        model: config.model,
        smartModel: config.router ? config.smartModel : null,
        voice: speech?.provider ?? 'aparelho',
        uptimeS: Math.round(process.uptime()),
        bornAt: bornAt(),
        // O app grava e o servidor transcreve quando há serviço de transcrição; senão usa o do navegador.
        listen: Boolean(speech?.enabled) && config.serverListen,
        // O servidor consegue transcrever? O app usa isso como reserva quando o reconhecimento do navegador falha.
        listenAvailable: Boolean(speech?.enabled),
        voiceprint: voiceprints ? voiceprints.status() : { available: false, people: [] },
        ...knowledgeStats(),
        documents: documents ? documents.list(200).length : 0,
        files: files ? files.list().length : 0,
        next: agenda ? agenda.next() : null,
        reminders: reminders ? reminders.open() : [],
        contacts: mailing ? mailing.counts().total : 0,
        rules: getRules(store, config).instructions.length,
      },
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
      const text = await runBriefing({ store, config, notifyOwner: jarvis.notifyOwner, agenda, reminders, force: true });
      res.json({ sent: true, text });
    }),
  );

  app.use(express.static(join(here, '..', 'public')));
  return app;
}
