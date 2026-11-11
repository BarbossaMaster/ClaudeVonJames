import { money, localTime } from './util.js';
import { getRules } from './store.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Números do período, calculados direto do banco (nunca pelo modelo). */
export function snapshot(store, config, since) {
  const s = store.stats(since);
  const c = (t) => s[t]?.count ?? 0;
  const rules = getRules(store, config);
  const pending = store.listEvents({ status: 'pending', limit: 20 }).reverse();
  return {
    since,
    questionsAnswered: s.customer_message?.handled ?? 0,
    conversationsEscalated: c('escalation'),
    newMembers: c('new_member'),
    cancellations: c('cancellation'),
    sales: { count: c('sale'), total: s.sale?.total ?? 0 },
    refunds: { count: c('refund'), total: s.refund?.total ?? 0 },
    paymentFailures: c('payment_failed'),
    pending: pending.map((e) => ({
      id: e.id,
      type: e.type,
      summary: e.summary,
      amount: e.amount,
      contact: e.contact_name || e.contact,
      urgency: e.urgency,
    })),
    currency: rules.currency,
  };
}

/** Texto curto do resumo, no estilo "31 perguntas respondidas. 14 novos membros. Nada precisa do senhor." */
export function briefingText(snap, config) {
  const lines = [];
  lines.push(plural(snap.questionsAnswered, 'pergunta respondida', 'perguntas respondidas') + '.');
  lines.push(plural(snap.newMembers, 'novo membro', 'novos membros') + '.');
  if (snap.sales.count)
    lines.push(`${plural(snap.sales.count, 'venda', 'vendas')} (${money(snap.sales.total, snap.currency)}).`);
  if (snap.refunds.count)
    lines.push(
      `${plural(snap.refunds.count, 'reembolso', 'reembolsos')} (${money(snap.refunds.total, snap.currency)}).`,
    );
  if (snap.cancellations) lines.push(plural(snap.cancellations, 'cancelamento', 'cancelamentos') + '.');
  if (snap.paymentFailures)
    lines.push(plural(snap.paymentFailures, 'pagamento falhou', 'pagamentos falharam') + '.');

  if (!snap.pending.length) {
    lines.push(`Nada precisa do ${config.ownerTitle}.`);
  } else {
    lines.push(
      `${plural(snap.pending.length, 'item aguarda', 'itens aguardam')} sua decisão:`,
      ...snap.pending.map(
        (p) =>
          `#${p.id} ${p.summary ?? p.type}${p.amount ? ` (${money(p.amount, snap.currency)})` : ''}${p.contact ? ` — ${p.contact}` : ''}`,
      ),
    );
  }
  return lines.join('\n');
}

/**
 * Envia o resumo diário uma vez por dia, a partir da hora configurada.
 * `force` ignora o horário (usado por POST /api/briefing).
 */
export async function runBriefing({ store, config, notifyOwner, force = false }) {
  const now = store.now();
  const { dateKey, hour } = localTime(now, config.timezone);
  const last = store.get('lastBriefing', { dateKey: null, ts: 0 });
  if (!force && (hour < config.briefingHour || last.dateKey === dateKey)) return null;

  const since = last.ts ? last.ts + 1 : now - 24 * 3600 * 1000;
  const snap = snapshot(store, config, since);
  const text = briefingText(snap, config);
  // Marca antes de enviar: uma falha de envio não pode virar spam de reenvio a cada minuto.
  store.set('lastBriefing', { dateKey, ts: now });
  await notifyOwner(text, { kind: 'briefing' });
  return text;
}

export function startScheduler(deps, { intervalMs = 60_000, log = console.error } = {}) {
  const tick = () => runBriefing(deps).catch((e) => log('[jarvis] falha no resumo diário:', e.message));
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
