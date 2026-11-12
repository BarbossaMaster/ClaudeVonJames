import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, serve, say, use } from './helpers.js';
import { normalizePhone, samePhone } from '../src/util.js';
import { getRules } from '../src/store.js';
import { snapshot, briefingText, runBriefing } from '../src/briefing.js';
import { createWhatsApp, parseWebhook } from '../src/whatsapp.js';

const OWNER = '551188887777'; // como o WhatsApp entrega: sem o nono dígito
const CLIENT = '5521999990000';
const H = 3600 * 1000;

test('telefone brasileiro com e sem o nono dígito é o mesmo contato', () => {
  assert.equal(normalizePhone('+55 (11) 98888-7777'), '551188887777');
  assert.ok(samePhone('+55 11 98888-7777', OWNER));
  assert.ok(!samePhone('', ''));
  assert.ok(!samePhone(CLIENT, OWNER));
});

test('resumo diário: números do banco e "nada precisa do senhor"', () => {
  const { store, config } = setup();
  for (let i = 0; i < 31; i++) store.addEvent({ type: 'customer_message', status: 'handled' });
  for (let i = 0; i < 14; i++) store.addEvent({ type: 'new_member' });
  const text = briefingText(snapshot(store, config, 0), config);
  assert.equal(text, '31 perguntas respondidas.\n14 novos membros.\nNada precisa do senhor.');
});

test('resumo diário lista pendências e só sai uma vez por dia, depois da hora marcada', async () => {
  const { store, config, jarvis, sent, advance } = setup();
  store.addEvent({ type: 'sale', amount: 300 });
  store.addEvent({ type: 'escalation', status: 'pending', summary: 'Cliente pede parcelamento', amount: 900, contactName: 'Ana' });
  const deps = { store, config, notifyOwner: jarvis.notifyOwner };

  assert.equal(await runBriefing(deps), null, 'antes das 18h não envia');
  advance(7 * H); // 19h em São Paulo
  const text = await runBriefing(deps);
  assert.match(text, /1 venda \(R\$\s300,00\)/);
  assert.match(text, /1 item aguarda sua decisão:\n#2 Cliente pede parcelamento \(R\$\s900,00\) — Ana/);
  assert.equal(sent.length, 1);
  assert.equal(await runBriefing(deps), null, 'não repete no mesmo dia');
  advance(24 * H);
  assert.ok(await runBriefing(deps), 'envia de novo no dia seguinte');
});

test('evento acima do limite avisa o dono na hora; abaixo, só registra', async () => {
  const { jarvis, sent, store } = setup();
  const small = await jarvis.ingestEvent({ type: 'refund', amount: 150, summary: 'Reembolso curso' });
  assert.equal(small.alerted, false);
  assert.equal(sent.length, 0);

  const big = await jarvis.ingestEvent({ type: 'refund', amount: 2500, summary: 'Reembolso mentoria', contact_name: 'Bia' });
  assert.equal(big.alerted, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /🚨 Pedido de reembolso de R\$\s2\.500,00/);
  assert.equal(store.getEvent(big.id).status, 'pending');

  const sale = await jarvis.ingestEvent({ type: 'sale', amount: 5000 });
  assert.equal(store.getEvent(sale.id).status, 'handled', 'venda grande avisa mas não vira pendência');
  assert.match(sent[1].text, /💰 Venda grande/);
});

test('dono dita a regra por voz e ela passa a valer', async () => {
  const { brain, store, config, client, jarvis, sent } = setup({
    script: [
      use('update_rules', { threshold: 5000, add_instructions: ['Nunca dar desconto acima de 20%.'] }),
      say('Entendido, senhor. Só o chamo acima de cinco mil reais.'),
    ],
  });
  const reply = await brain.owner('Só me chame se passar de 5 mil. E nada de desconto acima de 20%.', { channel: 'voice' });
  assert.match(reply, /Entendido, senhor/);
  assert.deepEqual(getRules(store, config), { threshold: 5000, currency: 'BRL', instructions: ['Nunca dar desconto acima de 20%.'] });

  // a requisição ao Claude segue o formato esperado e devolve o resultado da ferramenta
  const [first, second] = client.requests;
  assert.equal(first.model, 'claude-sonnet-5-5');
  assert.equal(first.output_config.effort, 'medium');
  assert.match(first.messages.at(-1).content, /lida em voz alta/);
  assert.equal(second.messages.at(-1).content[0].type, 'tool_result');

  await jarvis.ingestEvent({ type: 'refund', amount: 3000 });
  assert.equal(sent.length, 0, '3 mil já não alerta com o limite em 5 mil');
});

test('cliente no WhatsApp: resposta conta como pergunta respondida', async () => {
  const { jarvis, sent, store, config, client } = setup({ script: [say('O acesso chega por e-mail em até 5 minutos.')] });
  await jarvis.handleWhatsApp({ id: 'm1', from: CLIENT, name: 'Carlos', type: 'text', text: 'Comprei, cadê meu acesso?' });
  assert.deepEqual(sent, [{ to: CLIENT, text: 'O acesso chega por e-mail em até 5 minutos.' }]);
  assert.equal(snapshot(store, config, 0).questionsAnswered, 1);
  assert.deepEqual(client.requests[0].tools.map((t) => t.name), ['escalate_to_owner'], 'cliente não enxerga ferramentas do dono');
  assert.doesNotMatch(client.requests[0].system, /trate-o por/);

  await jarvis.handleWhatsApp({ id: 'm1', from: CLIENT, type: 'text', text: 'Comprei, cadê meu acesso?' });
  assert.equal(sent.length, 1, 'webhook repetido é ignorado');
});

test('cliente pede algo grande: escala, avisa o dono, e o dono resolve respondendo ao cliente', async () => {
  const { jarvis, sent, store, config } = setup({
    script: [
      use('escalate_to_owner', { summary: 'Carlos quer reembolso da mentoria.', amount: 3000, urgency: 'normal' }),
      say('Vou confirmar com a equipe e retorno.'),
      use('resolve_item', { id: 2, decision: 'Aprovado', message_to_contact: 'Carlos, seu reembolso foi aprovado.' }),
      say('Feito, senhor.'),
    ],
  });
  await jarvis.handleWhatsApp({ id: 'm1', from: CLIENT, name: 'Carlos', type: 'text', text: 'Quero meu dinheiro de volta' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, '+55 (11) 98888-7777');
  assert.match(sent[0].text, /🚨 Preciso do senhor\.\n#2 Carlos quer reembolso da mentoria\. \(R\$\s3\.000,00\)/);
  assert.equal(sent[1].to, CLIENT);
  const snap = snapshot(store, config, 0);
  assert.equal(snap.questionsAnswered, 0);
  assert.equal(snap.pending.length, 1);

  await jarvis.handleWhatsApp({ id: 'm2', from: OWNER, type: 'text', text: 'Aprova o #2' });
  assert.deepEqual(sent[2], { to: CLIENT, text: 'Carlos, seu reembolso foi aprovado.' });
  assert.deepEqual(sent[3], { to: OWNER, text: 'Feito, senhor.' });
  assert.equal(store.getEvent(2).status, 'resolved');
  assert.equal(snapshot(store, config, 0).pending.length, 0);
});

test('falha do Claude: cliente recebe retorno e o dono fica com a pendência', async () => {
  const { jarvis, sent, store } = setup({ script: [] });
  await jarvis.handleWhatsApp({ id: 'm1', from: CLIENT, type: 'text', text: 'Oi' });
  assert.match(sent[0].text, /Vou confirmar com a equipe/);
  assert.equal(store.listEvents({ status: 'pending' }).length, 1);
});

test('áudio no WhatsApp: transcreve, responde em áudio; sem voz configurada pede texto', async () => {
  const speech = {
    enabled: true,
    canSpeak: true,
    transcribe: async () => 'como está o negócio?',
    speak: async (t, o) => ({ buffer: Buffer.from(`${o.format}:${t}`), mime: 'audio/ogg' }),
  };
  const a = setup({ script: [say('Tudo em ordem, senhor.')], speech });
  await a.jarvis.handleWhatsApp({ id: 'a1', from: OWNER, type: 'audio', audioId: 'media1' });
  assert.equal(a.sent[0].audio.toString(), 'voice:Tudo em ordem, senhor.');
  assert.equal(a.client.requests[0].tools.length, 13, 'áudio do dono usa as ferramentas do dono');

  const b = setup();
  await b.jarvis.handleWhatsApp({ id: 'a1', from: CLIENT, type: 'audio', audioId: 'media1' });
  assert.match(b.sent[0].text, /não consigo ouvir áudios/);
});

test('HTTP: token protege a API; webhook verifica; chat e eventos funcionam', async () => {
  const { app, store } = setup({ script: [say('Às ordens.')] });
  const { base, close } = await serve(app);
  try {
    const auth = { Authorization: 'Bearer segredo', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer errado' } })).status, 401);
    const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
    assert.equal(state.rules.threshold, 2000);

    const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'Olá', channel: 'voice' }) });
    const chatBody = await chat.json();
    assert.equal(chatBody.reply, 'Às ordens.');
    assert.deepEqual(chatBody.documents, []);
    assert.equal(chatBody.trace.model, 'claude-sonnet-5-5');
    assert.equal(chatBody.trace.steps, 1);
    assert.deepEqual(chatBody.trace.tools, []);

    const bad = await fetch(`${base}/api/events`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'hack' }) });
    assert.equal(bad.status, 400);
    const ev = await fetch(`${base}/api/events`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'new_member', contact_name: 'Duda' }) });
    assert.equal(ev.status, 201);
    assert.equal(store.listEvents({ type: 'new_member' }).length, 1);

    const ok = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=42`);
    assert.equal(await ok.text(), '42');
    assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42`)).status, 403);

    assert.equal((await fetch(`${base}/`)).status, 200, 'app de voz é servido');
  } finally {
    await close();
  }
});

test('WhatsApp real: assinatura do webhook, parse e envio', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), { ok: true, json: async () => ({}) });
  const wa = createWhatsApp({ token: 't', phoneNumberId: '123', appSecret: 'shh', graphVersion: 'v21.0' }, { fetchImpl });
  const raw = Buffer.from('{"a":1}');
  const sig = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex');
  assert.ok(wa.verifySignature(raw, sig));
  assert.ok(!wa.verifySignature(raw, 'sha256=00'));
  assert.ok(!wa.verifySignature(raw, undefined));
  assert.ok(!createWhatsApp({ token: 't', phoneNumberId: '1' }).verifySignature(raw, sig), 'live sem app secret recusa');

  await wa.sendText('5511', 'oi');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/123/messages');
  assert.deepEqual(calls[0].body, { messaging_product: 'whatsapp', to: '5511', type: 'text', text: { body: 'oi' } });

  const msgs = parseWebhook({ entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '5521', profile: { name: 'Carlos' } }],
    messages: [{ id: 'x', from: '5521', type: 'text', text: { body: 'oi' } }, { id: 'y', from: '5521', type: 'audio', audio: { id: 'm9' } }],
  } }] }] });
  assert.deepEqual(msgs[0], { id: 'x', from: '5521', name: 'Carlos', type: 'text', text: 'oi', audioId: null });
  assert.equal(msgs[1].audioId, 'm9');
  assert.deepEqual(parseWebhook({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }), []);
});

test('janela de 24h fechada: resumo vai por template quando configurado', async () => {
  const { jarvis, sent, whatsapp, config, advance } = setup({ env: { WHATSAPP_BRIEFING_TEMPLATE: 'resumo_diario' } });
  whatsapp.live = true;
  await jarvis.notifyOwner('Resumo');
  assert.equal(sent[0].template, 'resumo_diario');
  await jarvis.handleWhatsApp({ id: 'o1', from: OWNER, type: 'image' }); // dono escreveu: janela reabre
  advance(H);
  await jarvis.notifyOwner('Resumo 2');
  assert.equal(sent.at(-1).template, undefined);
  assert.equal(config.whatsapp.templateLang, 'pt_BR');
});

test('voz do app: /api/speak devolve MP3 quando há serviço de voz; 503 sem', async () => {
  const speech = { enabled: false, canSpeak: true, speak: async (t, o) => ({ buffer: Buffer.from(`${o.format}:${t}`), mime: 'audio/mpeg' }) };
  const a = await serve(setup({ speech }).app);
  const b = await serve(setup().app);
  try {
    const h = { Authorization: 'Bearer segredo', 'Content-Type': 'application/json' };
    const body = JSON.stringify({ text: 'Olá' });
    const ok = await fetch(`${a.base}/api/speak`, { method: 'POST', headers: h, body });
    assert.equal(ok.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await ok.text(), 'mp3:Olá');
    assert.equal((await (await fetch(`${a.base}/api/state`, { headers: h })).json()).voice, true);
    assert.equal((await fetch(`${a.base}/api/speak`, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(`${b.base}/api/speak`, { method: 'POST', headers: h, body })).status, 503);
  } finally {
    await a.close(); await b.close();
  }
});

test('provedor de voz: ElevenLabs tem prioridade e recebe o pedido certo', async () => {
  const { createSpeech } = await import('../src/speech.js');
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push({ url, init }), { ok: true, arrayBuffer: async () => new ArrayBuffer(3) });
  const s = createSpeech({ openaiKey: 'o', elevenKey: 'e', elevenVoice: 'voz1', elevenModel: 'eleven_multilingual_v2', ttsModel: 'tts-1', ttsVoice: 'onyx' }, { fetchImpl });
  assert.equal(s.provider, 'elevenlabs');
  const out = await s.speak('Olá');
  assert.equal(out.mime, 'audio/mpeg');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voz1?output_format=mp3_44100_128');
  assert.equal(calls[0].init.headers['xi-api-key'], 'e');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Olá', model_id: 'eleven_multilingual_v2' });

  const o = createSpeech({ openaiKey: 'o', ttsModel: 'tts-1', ttsVoice: 'onyx' }, { fetchImpl });
  assert.equal((await o.speak('Oi', { format: 'voice' })).mime, 'audio/ogg');
  assert.equal(JSON.parse(calls[1].init.body).response_format, 'opus');
  assert.equal(createSpeech({}).canSpeak, false);
});

test('voz mais ágil: números do dia vão no contexto e o modo rápido é opcional', async () => {
  const a = setup({ script: [say('Tudo em ordem.')] });
  a.store.addEvent({ type: 'new_member' });
  await a.brain.owner('como está o negócio?', { channel: 'voice' });
  const req = a.client.requests[0];
  assert.match(req.messages.at(-1).content, /"newMembers":1/);
  assert.equal(req.speed, undefined);

  const b = setup({ script: [say('Ok.'), say('Ok.')], env: { JARVIS_FAST: '1', VOICE_SPEED: '9', JARVIS_MODEL: 'claude-opus-5-5' } });
  await b.brain.owner('oi', { channel: 'voice' });
  await b.brain.owner('oi', { channel: 'text' });
  assert.equal(b.client.requests[0].speed, 'fast');
  assert.equal(b.client.requests[1].speed, undefined, 'texto não usa o modo rápido');
  assert.equal(b.config.voiceRate, 1.6, 'velocidade fica dentro do limite');
});

const DOC = { title: 'Estratégia de Instagram', content: '## Objetivo\n\nGerar **demonstrações**.\n\n- Reels 3x por semana\n- Depoimentos 🙂\n\n1. Semana um\n2. Semana dois' };

test('PDF pelo app: o dono pede, o documento é gerado e abre pelo link', async () => {
  const t = setup({ script: [use('create_document', DOC), say('Pronto, senhor. Está na área Docs.')] });
  const { base, close } = await serve(t.app);
  try {
    const h = { Authorization: 'Bearer segredo', 'Content-Type': 'application/json' };
    const chat = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'faz um pdf', channel: 'voice' }) })).json();
    assert.equal(chat.reply, 'Pronto, senhor. Está na área Docs.');
    assert.equal(chat.documents.length, 1);
    assert.match(chat.documents[0].url, /^\/d\/[\w-]{20,}\.pdf$/);

    const pdf = await fetch(base + chat.documents[0].url);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /Estrategia-de-Instagram\.pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

    const list = await (await fetch(`${base}/api/docs`, { headers: h })).json();
    assert.equal(list.documents[0].title, 'Estratégia de Instagram');
    assert.equal((await fetch(`${base}/api/docs`)).status, 401);
    assert.equal((await fetch(`${base}/d/naoexiste1234567890.pdf`)).status, 404);

    // sem WhatsApp conectado, o modelo é informado de que não foi enviado
    const result = JSON.parse(t.client.requests[1].messages.at(-1).content[0].content);
    assert.equal(result.whatsapp, 'não solicitado');
    assert.equal(t.sent.length, 0);
  } finally {
    await close();
  }
});

test('PDF pelo WhatsApp: pedido feito por lá chega como documento; desconectado, avisa a verdade', async () => {
  const a = setup({ script: [use('create_document', DOC), say('Enviei, senhor.')] });
  a.whatsapp.live = true;
  await a.jarvis.handleWhatsApp({ id: 'd1', from: OWNER, type: 'text', text: 'me manda um pdf da estratégia' });
  assert.equal(a.sent[0].filename, 'Estrategia-de-Instagram.pdf');
  assert.equal(a.sent[0].document.subarray(0, 5).toString(), '%PDF-');
  assert.equal(a.sent[1].text, 'Enviei, senhor.');

  const b = setup({ script: [use('create_document', { ...DOC, send_whatsapp: true }), say('Está no app.')] });
  await b.brain.owner('gera e manda no whats', { channel: 'voice' });
  const result = JSON.parse(b.client.requests[1].messages.at(-1).content[0].content);
  assert.match(result.whatsapp, /não enviado: o WhatsApp ainda não está conectado/);
  assert.equal(b.sent.length, 0);
});

test('PDF com imagens e gráficos: o modelo recebe o catálogo e o PDF embute a imagem', async () => {
  const { renderPdf, loadImageLibrary } = await import('../src/documents.js');
  const library = loadImageLibrary('knowledge/imagens');
  assert.ok(library.logo, 'logo encontrado');
  assert.ok(library.images.painel, 'tela do painel no catálogo');
  const base = { title: 'T', business: 'Astro Gold', dateLabel: 'hoje' };
  const plain = await renderPdf({ ...base, content: 'Texto.' });
  const rich = await renderPdf({ ...base, library, content: 'Texto.\n\n![Painel](imagem:painel)\n\n```grafico\ntitulo: Funil\nAbordadas: 115\nResponderam: 55\n```\n\n![x](imagem:naoexiste)' });
  assert.equal(rich.subarray(0, 5).toString(), '%PDF-');
  assert.ok(rich.length > plain.length + 50_000, 'imagem embutida aumenta o arquivo');

  const t = setup({ script: [say('ok')], env: { KNOWLEDGE_DIR: 'knowledge' } });
  await t.brain.owner('oi');
  const desc = t.client.requests[0].tools.find((x) => x.name === 'create_document').input_schema.properties.content.description;
  assert.match(desc, /imagem:ID/);
  assert.match(desc, /painel \(Tela do Painel/);
  assert.match(desc, /```grafico/);
});

test('raciocínio por voz: médio por padrão, ajustável, valor inválido é ignorado', async () => {
  const a = setup({ script: [say('ok')], env: { JARVIS_VOICE_EFFORT: 'high' } });
  await a.brain.owner('oi', { channel: 'voice' });
  assert.equal(a.client.requests[0].output_config.effort, 'high');
  assert.equal(setup({ env: { JARVIS_VOICE_EFFORT: 'turbo' } }).config.voiceEffort, 'medium');
});

test('roteiro de atendimento: entra na base dos dois modos, com a orientação de como usar', async () => {
  const t = setup({ script: [say('Oi!'), say('ok')], env: { KNOWLEDGE_DIR: 'knowledge' } });
  await t.brain.contact('oi vi o vídeo de vocês', { contact: '5511911112222', contactName: 'Ana' });
  const lead = t.client.requests[0].system;
  assert.match(lead, /Arquivo: atendimento-whatsapp\.md/);
  assert.match(lead, /Nunca mencione Lovable/);
  assert.match(lead, /siga-o: ele define como conduzir esta conversa/);
  assert.deepEqual(t.client.requests[0].tools.map((x) => x.name), ['escalate_to_owner']);

  await t.brain.owner('oi');
  const owner = t.client.requests[1].system;
  assert.match(owner, /Arquivo: atendimento-whatsapp\.md/);
  assert.match(owner, /valem para quem está de fora, não para ele/);
});

test('modo rápido não é enviado a modelos que não o aceitam', async () => {
  const t = setup({ script: [say('ok')], env: { JARVIS_FAST: '1' } }); // padrão: Sonnet
  await t.brain.owner('oi', { channel: 'voice' });
  assert.equal(t.client.requests[0].model, 'claude-sonnet-5-5');
  assert.equal(t.client.requests[0].speed, undefined);
});

test('troca automática de modelo: simples no Sonnet, importante no Opus, falha cai no Sonnet', async () => {
  const on = { JARVIS_ROUTER: 'on' };
  const verdict = (v) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: v }] });

  // curta: nem consulta o classificador
  const a = setup({ script: [say('Bom dia.')], env: on });
  await a.brain.owner('bom dia James');
  assert.equal(a.client.requests.length, 1);
  assert.equal(a.client.requests[0].model, 'claude-sonnet-5-5');

  // classificador diz IMPORTANTE: turno inteiro no Opus
  const b = setup({ script: [verdict('IMPORTANTE'), say('Análise.')], env: on });
  const meta = {};
  await b.brain.owner('vale a pena dar 20% de desconto para fechar com a loja da Ana ainda este mês?', { meta });
  assert.equal(b.client.requests[0].model, 'claude-haiku-5-5');
  assert.match(b.client.requests[0].messages[0].content, /20% de desconto/);
  assert.equal(b.client.requests[1].model, 'claude-opus-5-5');
  assert.equal(meta.model, 'claude-opus-5-5');

  // classificador diz SIMPLES
  const c = setup({ script: [verdict('SIMPLES'), say('Três vendas.')], env: on });
  await c.brain.owner('quantas vendas a gente teve hoje até agora mesmo?');
  assert.equal(c.client.requests[1].model, 'claude-sonnet-5-5');

  // pedido explícito dispensa o classificador
  const d = setup({ script: [say('Pensando.')], env: on });
  await d.brain.owner('pensa bem nisso antes de responder');
  assert.equal(d.client.requests[0].model, 'claude-opus-5-5');

  // classificador fora do ar: segue no Sonnet e responde normalmente
  const e = setup({ script: [() => { throw new Error('timeout'); }, say('Respondi.')], env: on });
  assert.equal(await e.brain.owner('me explica como está o funil de prospecção desta semana'), 'Respondi.');
  assert.equal(e.client.requests[1].model, 'claude-sonnet-5-5');

  // cliente no WhatsApp não passa pela troca
  const f = setup({ script: [say('Olá!')], env: on });
  await f.brain.contact('queria entender melhor os planos e valores da plataforma de vocês', { contact: '5521999990000' });
  assert.equal(f.client.requests.length, 1);
  assert.equal(f.client.requests[0].model, 'claude-sonnet-5-5');
});

test('rastro do turno: ferramentas e voltas chegam ao app; estado traz o resumo do sistema', async () => {
  const t = setup({ script: [use('get_business_snapshot', { period_days: 7 }), say('Semana tranquila.')] });
  const { base, close } = await serve(t.app);
  try {
    const h = { Authorization: 'Bearer segredo', 'Content-Type': 'application/json' };
    const chat = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'como foi a semana?' }) })).json();
    assert.deepEqual(chat.trace.tools, ['get_business_snapshot']);
    assert.equal(chat.trace.steps, 2);
    assert.ok(chat.trace.ms >= 0);
    const state = await (await fetch(`${base}/api/state`, { headers: h })).json();
    assert.equal(state.system.model, 'claude-sonnet-5-5');
    assert.equal(state.system.smartModel, null, 'troca automática desligada nos testes');
    assert.equal(state.system.voice, 'aparelho');
  } finally {
    await close();
  }
});

test('vida do assistente: nascimento fixo, saberes e memórias crescem com o uso', async () => {
  const t = setup({ script: [use('remember', { fact: 'A garantia é de um ano.' }), say('Anotado.')] });
  const { base, close } = await serve(t.app);
  try {
    const h = { Authorization: 'Bearer segredo', 'Content-Type': 'application/json' };
    const get = async () => (await (await fetch(`${base}/api/state`, { headers: h })).json()).system;
    const a = await get();
    assert.ok(a.bornAt > 0);
    t.advance(3600_000);
    await fetch(`${base}/api/chat`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'anota: a garantia é de um ano' }) });
    const b = await get();
    assert.equal(b.bornAt, a.bornAt, 'a data de nascimento não muda');
    assert.equal(b.saberes, a.saberes + 1, 'o fato ensinado vira um saber');
    assert.equal(b.memorias, a.memorias + 2, 'pergunta e resposta viram memórias');
  } finally {
    await close();
  }
});

// WAV de teste: tom constante de `value` durante `seconds` (16 kHz, 16 bits, mono).
function wav(value, seconds = 4) {
  const n = Math.round(seconds * 16000), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  return b;
}

test('escuta no servidor: transcreve a fala e reconhece de quem é a voz', async () => {
  const speech = { enabled: true, canSpeak: false, listener: 'teste', transcribe: async (buf, mime) => `ouvi ${buf.length} bytes de ${mime}` };
  const t = setup({ speech });
  const { base, close } = await serve(t.app);
  try {
    const auth = { Authorization: 'Bearer segredo' }, h = { ...auth, 'Content-Type': 'audio/wav' };
    const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: h, body }); return { status: r.status, json: await r.json() }; };

    // sem ninguém cadastrado: transcreve e avisa que não há impressão vocal
    const a = await post('/api/listen', wav(0.5));
    assert.match(a.json.text, /^ouvi \d+ bytes de audio\/wav$/);
    assert.equal(a.json.speaker.enrolled, false);

    // cadastro: amostra curta é recusada; duas amostras boas ficam guardadas
    assert.equal((await post('/api/voiceprint?name=Dono', wav(0.5, 1))).status, 422);
    assert.equal((await post('/api/voiceprint?name=Dono', wav(0.5))).json.samples, 1);
    const e2 = await post('/api/voiceprint?name=Dono', wav(0.5));
    assert.deepEqual(e2.json.people, [{ name: 'dono', samples: 2 }]);

    // a voz do dono passa; outra voz não; fala curta vem marcada
    assert.equal((await post('/api/listen', wav(0.5))).json.speaker.match, true);
    const other = (await post('/api/listen', wav(-0.5))).json.speaker;
    assert.equal(other.match, false);
    assert.ok(other.score < 0.5);
    assert.equal((await post('/api/listen', wav(0.5, 0.8))).json.speaker.short, true);

    // estado, proteção e remoção
    const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
    assert.equal(state.system.listen, true);
    assert.equal(state.system.voiceprint.people.length, 1);
    assert.equal((await fetch(`${base}/api/listen`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(0.5) })).status, 401);
    assert.equal((await post('/api/listen', Buffer.from('x'))).status, 400);
    const del = await (await fetch(`${base}/api/voiceprint`, { method: 'DELETE', headers: auth })).json();
    assert.deepEqual(del.people, []);
  } finally {
    await close();
  }
});

test('transcrição: ElevenLabs primeiro; sem permissão na chave, explica o que falta', async () => {
  const { createSpeech } = await import('../src/speech.js');
  const calls = [];
  const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => '' });
  let s = createSpeech({ elevenKey: 'e', elevenVoice: 'v' }, { fetchImpl: async (url, init) => (calls.push({ url, init }), ok({ text: ' Bom dia. ' })) });
  assert.equal(await s.transcribe(Buffer.from('wav'), 'audio/wav'), 'Bom dia.');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(calls[0].init.headers['xi-api-key'], 'e');
  assert.equal(calls[0].init.body.get('model_id'), 'scribe_v1');
  assert.equal(calls[0].init.body.get('language_code'), 'pt');

  s = createSpeech({ elevenKey: 'e' }, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'missing_permissions' }) });
  await assert.rejects(() => s.transcribe(Buffer.from('wav'), 'audio/wav'), /permissão de Speech to Text/);
  assert.equal(createSpeech({}).enabled, false);
});

test('WhatsApp: envio recusado para número brasileiro tenta o outro formato do nono dígito', async () => {
  const tried = [];
  const fetchImpl = async (_url, init) => {
    const to = JSON.parse(init.body).to; tried.push(to);
    return to === '5531988887777' ? { ok: true, status: 200, json: async () => ({}) } : { ok: false, status: 400, text: async () => '(#131030) Recipient phone number not in allowed list' };
  };
  const wa = createWhatsApp({ token: 't', phoneNumberId: '1', appSecret: 's', graphVersion: 'v21.0' }, { fetchImpl });
  await wa.sendText('553188887777', 'oi');
  assert.deepEqual(tried, ['553188887777', '5531988887777']);
  await assert.rejects(() => wa.sendText('14155550100', 'oi'), /131030/, 'número de outro país não tem segunda tentativa');
});

test('arquivos do dono: envia, o James busca e lê; cliente não enxerga; PDF vira texto', async () => {
  const t = setup({ script: [use('search_files', { query: 'multa rescisão' }), say('A multa é de dois meses.'), say('Olá!')] });
  const { base, close } = await serve(t.app);
  try {
    const auth = { Authorization: 'Bearer segredo' };
    const up = (body, name, type) => fetch(`${base}/api/files`, { method: 'POST', headers: { ...auth, 'Content-Type': type, 'x-filename': encodeURIComponent(name) }, body });
    const contrato = 'Contrato de prestação de serviços.\n\nCláusula 7. Em caso de rescisão antecipada, a multa é de dois meses de mensalidade.\n' + 'Demais condições gerais. '.repeat(40);
    const r = await up(contrato, 'contrato açaí.txt', 'text/plain');
    assert.equal(r.status, 201);
    const file = await r.json();
    assert.equal(file.name, 'contrato açaí.txt');

    // formatos não aceitos e arquivo vazio são recusados com explicação; sem token, nada entra
    assert.equal((await up(Buffer.from([1, 2, 3, 4]), 'foto.png', 'image/png')).status, 422);
    assert.equal((await fetch(`${base}/api/files`, { method: 'POST', body: 'x' })).status, 401);

    // PDF de verdade: gera um com o próprio gerador e manda de volta
    const { renderPdf } = await import('../src/documents.js');
    const pdf = await renderPdf({ title: 'Tabela', content: 'O plano completo custa novecentos reais por mês.', business: 'Astro Gold', dateLabel: 'hoje' });
    const p = await (await up(pdf, 'tabela.pdf', 'application/pdf')).json();
    assert.equal(p.pages, 1);
    assert.match(t.files.read(p.id).text, /novecentos reais/);

    // o dono pergunta: o índice vai no prompt e a busca devolve o trecho certo
    const chat = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'qual a multa de rescisão?' }) })).json();
    assert.equal(chat.reply, 'A multa é de dois meses.');
    assert.match(t.client.requests[0].system, new RegExp(`\\[${file.id}\\] contrato açaí\\.txt`));
    const found = JSON.parse(t.client.requests[1].messages.at(-1).content[0].content);
    assert.equal(found[0].id, file.id);
    assert.match(found[0].snippet, /multa é de dois meses/);

    // cliente no WhatsApp: sem índice e sem ferramentas de arquivo
    await t.brain.contact('qual a multa de vocês?', { contact: '5521999990000' });
    const lead = t.client.requests[2];
    assert.doesNotMatch(lead.system, /contrato açaí/);
    assert.deepEqual(lead.tools.map((x) => x.name), ['escalate_to_owner']);

    // listar e apagar
    const list = await (await fetch(`${base}/api/files`, { headers: auth })).json();
    assert.equal(list.files.length, 2);
    const del = await (await fetch(`${base}/api/files/${file.id}`, { method: 'DELETE', headers: auth })).json();
    assert.deepEqual(del.files.map((f) => f.name), ['tabela.pdf']);
  } finally {
    await close();
  }
});

test('agenda: o dono marca por conversa, vê na lista, exporta para o calendário e recebe no resumo', async () => {
  const t = setup({ script: [use('schedule_event', { title: 'Demonstração com a Ana', start: '2026-11-12T15:30', duration_minutes: 45, notes: 'Mostrar o pipeline' }), say('Marcado para amanhã às 15h30.')] });
  const { base, close } = await serve(t.app);
  try {
    const h = { Authorization: 'Bearer segredo', 'Content-Type': 'application/json' };
    await fetch(`${base}/api/chat`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'marca uma demonstração com a Ana amanhã às 15h30' }) });
    assert.match(t.client.requests[0].messages.at(-1).content, /Agenda dos próximos 7 dias: \[\]/);
    assert.match(t.client.requests[0].messages.at(-1).content, /Pendências em aberto que dependem do dono: .*serviço de envio de e-mail/);

    const list = await (await fetch(`${base}/api/agenda`, { headers: h })).json();
    assert.equal(list.events.length, 1);
    assert.equal(list.events[0].title, 'Demonstração com a Ana');
    assert.match(list.events[0].when, /12\/11\/2026.*15:30/, 'guardado no horário de São Paulo');
    assert.equal(list.events[0].minutes, 45);

    // calendário para o celular: só abre com a chave; horário em UTC (15:30 em SP = 18:30Z)
    const ics = await fetch(base + list.ics);
    assert.match(ics.headers.get('content-type'), /text\/calendar/);
    const body = await ics.text();
    assert.match(body, /DTSTART:20261112T183000Z/);
    assert.match(body, /SUMMARY:Demonstração com a Ana/);
    assert.equal((await fetch(`${base}/cal/chave-errada.ics`)).status, 404);

    // direto pela tela, validação, próximo compromisso no estado e remoção
    const add = await fetch(`${base}/api/agenda`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Reunião com o sócio', start: '2026-11-11T16:00' }) });
    assert.equal(add.status, 201);
    assert.equal((await fetch(`${base}/api/agenda`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'x', start: 'amanhã' }) })).status, 422);
    const state = await (await fetch(`${base}/api/state`, { headers: h })).json();
    assert.equal(state.system.next.title, 'Reunião com o sócio');
    assert.equal((await fetch(`${base}/api/agenda`)).status, 401);

    // resumo das 18h traz a agenda
    t.advance(7 * 3600 * 1000);
    const { runBriefing } = await import('../src/briefing.js');
    const text = await runBriefing({ store: t.store, config: t.config, notifyOwner: async () => {}, agenda: t.agenda });
    assert.match(text, /Agenda:\n.*15:30 · Demonstração com a Ana/);

    const del = await (await fetch(`${base}/api/agenda/${list.events[0].id}`, { method: 'DELETE', headers: h })).json();
    assert.equal(del.events.some((e) => e.title === 'Demonstração com a Ana'), false);
  } finally {
    await close();
  }
});

test('modelo das conversas: Sonnet fixo por padrão; a troca automática só liga por opção', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig({}).router, false);
  assert.equal(loadConfig({}).model, 'claude-sonnet-5-5');
  assert.equal(loadConfig({ JARVIS_ROUTER: 'on' }).router, true);
});

test('lembretes do Guardião: nascem com as duas pendências, entram no resumo e somem quando concluídos', async () => {
  const t = setup({ script: [use('complete_reminder', { id: 1 }), say('Anotado, senhor.')] });
  assert.equal(t.reminders.open().length, 2);
  assert.match(t.reminders.open()[1].text, /token da API de Marketing da Meta/);
  t.advance(7 * 3600 * 1000);
  const { runBriefing } = await import('../src/briefing.js');
  const text = await runBriefing({ store: t.store, config: t.config, notifyOwner: async () => {}, reminders: t.reminders });
  assert.match(text, /Pendente com o senhor:\n- Escolher o serviço de envio de e-mail/);
  await t.brain.owner('já escolhi o Brevo e criei a chave');
  assert.deepEqual(t.reminders.open().map((r) => r.id), [2]);
  assert.equal(t.reminders.add('Mandar o logo com o nome escrito').id, 3);
});
