/**
 * E-mail marketing, primeira parte: lista de contatos por etapa e rascunhos de campanha.
 * O envio ainda não existe: depende de o dono escolher o serviço (Brevo, Mailchimp ou Resend).
 */
export const STAGES = ['interessado', 'demonstracao', 'cliente'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function createMailing({ store }) {
  const stageOf = (s) => {
    const v = String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    return STAGES.includes(v) ? v : 'interessado';
  };
  return {
    addContact({ name, email, stage, notes }) {
      const mail = String(email ?? '').trim().toLowerCase();
      if (!EMAIL.test(mail)) throw new Error(`e-mail inválido: ${String(email ?? '').slice(0, 60)}`);
      return store.upsertContact({ name: String(name ?? '').trim().slice(0, 120) || mail.split('@')[0], email: mail, stage: stageOf(stage), notes: String(notes ?? '').slice(0, 500) });
    },
    /** Importa várias linhas "nome, e-mail[, etapa]" (ou só o e-mail). Devolve quantas entraram e quais falharam. */
    importLines(text) {
      let added = 0; const failed = [];
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim(); if (!line) continue;
        const cols = line.split(/[;,\t]/).map((c) => c.trim());
        const at = cols.findIndex((c) => c.includes('@'));
        try {
          if (at === -1) throw new Error('sem e-mail');
          this.addContact({ email: cols[at], name: cols.filter((_, i) => i !== at)[0], stage: cols.filter((_, i) => i !== at)[1] });
          added++;
        } catch { failed.push(line.slice(0, 60)); }
      }
      return { added, failed };
    },
    contacts(stage) { return store.listContacts(stage ? stageOf(stage) : null); },
    removeContact(id) { store.removeContact(Number(id)); },
    counts() {
      const all = store.listContacts(null);
      return { total: all.length, ...Object.fromEntries(STAGES.map((s) => [s, all.filter((c) => c.stage === s).length])) };
    },
    saveDraft({ subject, body, audience }) {
      const s = String(subject ?? '').trim().slice(0, 160), b = String(body ?? '').trim();
      if (!s || !b) throw new Error('a campanha precisa de assunto e texto');
      const aud = String(audience ?? '').toLowerCase().trim() === 'todos' ? 'todos' : stageOf(audience);
      const id = store.addCampaign({ subject: s, body: b.slice(0, 20000), audience: aud });
      return { id, subject: s, audience: aud, recipients: aud === 'todos' ? this.counts().total : this.counts()[aud], status: 'rascunho' };
    },
    drafts() { return store.listCampaigns(); },
    removeDraft(id) { store.removeCampaign(Number(id)); },
  };
}
