import { randomBytes } from 'node:crypto';
import { localTime } from './util.js';

/** "2026-11-14T15:30" no fuso dado -> instante (ms). */
export function zonedToEpoch(isoLocal, timeZone) {
  const m = String(isoLocal ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) throw new Error('data inválida: use AAAA-MM-DDTHH:MM');
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(utc)).map((x) => [x.type, x.value]),
  );
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return utc - (shown - utc);
}

const icsDate = (ts) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (t) => String(t ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** Agenda do dono: compromissos guardados no banco, com exportação para o calendário do celular. */
export function createAgenda({ store, config }) {
  const view = (e) => ({
    id: e.id,
    title: e.title,
    notes: e.notes || '',
    start: e.start,
    end: e.end,
    when: localTime(e.start, config.timezone).label,
    day: localTime(e.start, config.timezone).dateKey,
    minutes: Math.round((e.end - e.start) / 60000),
  });

  return {
    add({ title, start, duration_minutes = 60, notes = '' }) {
      const t = String(title ?? '').trim().slice(0, 160);
      if (!t) throw new Error('o compromisso precisa de um título');
      const begin = zonedToEpoch(start, config.timezone);
      const mins = Math.min(24 * 60, Math.max(5, Number(duration_minutes) || 60));
      const id = store.addAppointment({ title: t, start: begin, end: begin + mins * 60000, notes: String(notes ?? '').slice(0, 1000) });
      return view(store.getAppointment(id));
    },

    /** Compromissos que ainda não terminaram, nos próximos `days` dias. */
    upcoming(days = 30, limit = 100) {
      const now = store.now();
      return store.listAppointments(now, now + days * 86400000, limit).map(view);
    },

    next() { return this.upcoming(365, 1)[0] ?? null; },

    remove(id) {
      const e = store.getAppointment(Number(id));
      if (!e) throw new Error(`compromisso #${id} não existe`);
      store.removeAppointment(e.id);
      return view(e);
    },

    /** Chave secreta do endereço .ics (criada na primeira vez). */
    icsKey() {
      let key = store.get('icsKey', '');
      if (!key) { key = randomBytes(18).toString('base64url'); store.set('icsKey', key); }
      return key;
    },

    /** Calendário no formato iCalendar, para assinar no Google Agenda ou no calendário do iPhone. */
    ics() {
      const now = store.now();
      const rows = store.listAppointments(now - 30 * 86400000, now + 365 * 86400000, 500);
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Guardiao//Agenda//PT', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(config.businessName)}`];
      for (const e of rows) {
        lines.push('BEGIN:VEVENT', `UID:agenda-${e.id}@guardiao`, `DTSTAMP:${icsDate(e.created)}`, `DTSTART:${icsDate(e.start)}`, `DTEND:${icsDate(e.end)}`, `SUMMARY:${icsText(e.title)}`);
        if (e.notes) lines.push(`DESCRIPTION:${icsText(e.notes)}`);
        lines.push('END:VEVENT');
      }
      lines.push('END:VCALENDAR');
      return lines.join('\r\n') + '\r\n';
    },
  };
}
