import { timingSafeEqual } from 'node:crypto';

export function money(amount, currency = 'BRL') {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(amount ?? 0);
}

/**
 * Normaliza telefone para comparação. Números brasileiros chegam do WhatsApp
 * às vezes sem o nono dígito (5511 9xxxx-xxxx -> 5511 xxxx-xxxx), então removemos
 * o 9 para comparar os dois formatos como iguais.
 */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') d = d.slice(0, 4) + d.slice(5);
  return d;
}

export function samePhone(a, b) {
  const x = normalizePhone(a);
  return x.length > 0 && x === normalizePhone(b);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Data e hora locais em um fuso: { dateKey: '2026-11-11', hour: 18, label: 'quarta-feira, 11/11/2026 18:05' } */
export function localTime(ts, timeZone) {
  const d = new Date(ts);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const label = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), label };
}

/** Executa tarefas da mesma chave em fila, para não intercalar respostas do mesmo contato. */
export function keyedQueue() {
  const tails = new Map();
  return (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    tails.set(key, tail);
    tail.then(() => tails.get(key) === tail && tails.delete(key));
    return next;
  };
}
