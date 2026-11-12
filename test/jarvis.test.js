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
  assert.equal(a.client.requests[0].tools.length, 6, 'áudio do dono usa as ferramentas do dono');

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
    assert.deepEqual(await chat.json(), { reply: 'Às ordens.', documents: [], model: 'claude-sonnet-5-5' });

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
