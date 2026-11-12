/**
 * Lembretes do Guardião: pendências que dependem do dono (uma decisão, um acesso, um documento).
 * Ele cobra com tato nas conversas e lista no resumo diário até serem concluídas.
 */
const SEED = [
  'Escolher o serviço de envio de e-mail (Brevo, Mailchimp ou Resend) e criar a chave, para ligar a aba E-mail.',
  'Enviar o token da API de Marketing da Meta e o ID da conta de anúncios, para ligar a aba Anúncios.',
];

export function createReminders({ store }) {
  const all = () => store.get('reminders', []);
  if (!store.get('remindersSeeded', false)) {
    store.set('reminders', SEED.map((text, i) => ({ id: i + 1, text, ts: store.now(), done: false })));
    store.set('remindersSeeded', true);
  }
  return {
    open() { return all().filter((r) => !r.done).map(({ id, text }) => ({ id, text })); },
    add(text) {
      const t = String(text ?? '').trim().slice(0, 300);
      if (!t) throw new Error('lembrete vazio');
      const list = all(), id = list.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      list.push({ id, text: t, ts: store.now(), done: false });
      store.set('reminders', list);
      return { id, text: t };
    },
    complete(id) {
      const list = all(), r = list.find((x) => x.id === Number(id) && !x.done);
      if (!r) throw new Error(`lembrete #${id} não existe ou já foi concluído`);
      r.done = true; store.set('reminders', list);
      return { id: r.id, text: r.text };
    },
  };
}
