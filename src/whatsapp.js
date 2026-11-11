import { createHmac } from 'node:crypto';
import { safeEqual } from './util.js';

/**
 * Cliente da API oficial do WhatsApp (Meta Cloud API).
 * Sem credenciais, cai no modo console: imprime as mensagens em vez de enviar,
 * para dar para testar tudo antes de ter a conta aprovada.
 */
export function createWhatsApp(cfg, { fetchImpl = fetch, log = console.log } = {}) {
  const live = Boolean(cfg.token && cfg.phoneNumberId);
  const base = `https://graph.facebook.com/${cfg.graphVersion}`;
  const auth = { Authorization: `Bearer ${cfg.token}` };

  const digits = (to) => String(to).replace(/\D/g, ''); // a API espera só dígitos, com DDI

  async function call(path, body) {
    const res = await fetchImpl(`${base}/${path}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  return {
    live,

    async sendText(to, text) {
      if (!live) return void log(`\n[whatsapp → ${to}]\n${text}\n`);
      // Limite de 4096 caracteres por mensagem de texto.
      for (let i = 0; i < text.length; i += 4000) {
        await call(`${cfg.phoneNumberId}/messages`, {
          messaging_product: 'whatsapp',
          to: digits(to),
          type: 'text',
          text: { body: text.slice(i, i + 4000) },
        });
      }
    },

    /** Mensagem de template (necessária fora da janela de 24h). O template deve ter 1 variável no corpo. */
    async sendTemplate(to, name, lang, bodyText) {
      if (!live) return void log(`\n[whatsapp template ${name} → ${to}]\n${bodyText}\n`);
      await call(`${cfg.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: digits(to),
        type: 'template',
        template: {
          name,
          language: { code: lang },
          components: [
            {
              type: 'body',
              // Parâmetros de template não aceitam quebras de linha nem mais de 1024 caracteres.
              parameters: [{ type: 'text', text: bodyText.replace(/\s*\n\s*/g, ' ').slice(0, 1000) }],
            },
          ],
        },
      });
    },

    async sendAudio(to, buffer, mime = 'audio/ogg') {
      if (!live) return void log(`\n[whatsapp áudio → ${to}] ${buffer.length} bytes\n`);
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mime);
      form.append('file', new Blob([buffer], { type: mime }), 'resposta.ogg');
      const up = await fetchImpl(`${base}/${cfg.phoneNumberId}/media`, { method: 'POST', headers: auth, body: form });
      if (!up.ok) throw new Error(`WhatsApp upload ${up.status}: ${(await up.text()).slice(0, 300)}`);
      const { id } = await up.json();
      await call(`${cfg.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: digits(to),
        type: 'audio',
        audio: { id },
      });
    },

    async downloadMedia(mediaId) {
      const meta = await fetchImpl(`${base}/${mediaId}`, { headers: auth });
      if (!meta.ok) throw new Error(`WhatsApp mídia ${meta.status}`);
      const { url, mime_type } = await meta.json();
      const bin = await fetchImpl(url, { headers: auth });
      if (!bin.ok) throw new Error(`WhatsApp download ${bin.status}`);
      return { buffer: Buffer.from(await bin.arrayBuffer()), mime: mime_type || 'audio/ogg' };
    },

    /** Confere a assinatura X-Hub-Signature-256 do webhook. Sem app secret configurado, recusa em modo live. */
    verifySignature(rawBody, header) {
      if (!cfg.appSecret) return !live;
      const expected = 'sha256=' + createHmac('sha256', cfg.appSecret).update(rawBody).digest('hex');
      return safeEqual(expected, header);
    },
  };
}

/** Extrai as mensagens recebidas de um payload de webhook da Meta. */
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const names = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        out.push({
          id: m.id,
          from: m.from,
          name: names[m.from] ?? null,
          type: m.type,
          text: m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : null,
          audioId: m.type === 'audio' ? m.audio?.id : null,
        });
      }
    }
  }
  return out;
}
