import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,            -- customer_message | new_member | sale | refund | cancellation | payment_failed | escalation | ...
  source TEXT,                   -- whatsapp | api | voice ...
  contact TEXT,
  contact_name TEXT,
  amount REAL,
  currency TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'handled',  -- handled | pending | resolved
  urgency TEXT,                  -- normal | urgent
  resolution TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  contact TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_contact ON turns(contact, id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT, pages INTEGER, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agenda (id INTEGER PRIMARY KEY AUTOINCREMENT, start INTEGER NOT NULL, end INTEGER NOT NULL, title TEXT NOT NULL, notes TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agenda_start ON agenda(start);
CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, stage TEXT NOT NULL, notes TEXT);
CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, audience TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'rascunho');
CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
`;

export function openStore(path = ':memory:', { now = () => Date.now() } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const store = {
    now,

    addEvent(e) {
      const r = db
        .prepare(
          `INSERT INTO events (ts,type,source,contact,contact_name,amount,currency,summary,status,urgency)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          e.ts ?? now(),
          e.type,
          e.source ?? null,
          e.contact ?? null,
          e.contactName ?? null,
          e.amount ?? null,
          e.currency ?? null,
          e.summary ?? null,
          e.status ?? 'handled',
          e.urgency ?? null,
        );
      return Number(r.lastInsertRowid);
    },

    getEvent(id) {
      return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    },

    updateEvent(id, fields) {
      const allowed = ['status', 'resolution', 'notified', 'summary', 'urgency'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      db.prepare(`UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => fields[k]),
        id,
      );
    },

    listEvents({ type, status, since, limit = 50 } = {}) {
      const where = [];
      const args = [];
      if (type) (where.push('type = ?'), args.push(type));
      if (status) (where.push('status = ?'), args.push(status));
      if (since) (where.push('ts >= ?'), args.push(since));
      const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 200));
    },

    /** Contagem e soma por tipo desde `since`. */
    stats(since = 0) {
      const rows = db
        .prepare(
          `SELECT type, status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total
           FROM events WHERE ts >= ? GROUP BY type, status`,
        )
        .all(since);
      const byType = {};
      for (const r of rows) {
        const t = (byType[r.type] ??= { count: 0, total: 0, handled: 0, pending: 0, resolved: 0 });
        t.count += r.n;
        t.total += r.total;
        t[r.status] = (t[r.status] ?? 0) + r.n;
      }
      return byType;
    },

    addTurn(contact, role, text) {
      db.prepare('INSERT INTO turns (ts,contact,role,text) VALUES (?,?,?,?)').run(now(), contact, role, text);
    },

    history(contact, limit = 20) {
      return db
        .prepare('SELECT role, text, ts FROM turns WHERE contact = ? ORDER BY id DESC LIMIT ?')
        .all(contact, limit)
        .reverse();
    },

    lastInboundTs(contact) {
      const r = db
        .prepare("SELECT MAX(ts) AS ts FROM turns WHERE contact = ? AND role = 'user'")
        .get(contact);
      return r?.ts ?? 0;
    },

    get(key, fallback = null) {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return r ? JSON.parse(r.value) : fallback;
    },

    set(key, value) {
      db.prepare(
        'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, JSON.stringify(value));
    },

    addDocument(id, title) {
      db.prepare('INSERT INTO documents (id, ts, title) VALUES (?,?,?)').run(id, now(), title);
    },

    getDocument(id) {
      return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    },

    listDocuments(limit = 30) {
      return db.prepare('SELECT * FROM documents ORDER BY ts DESC, rowid DESC LIMIT ?').all(limit);
    },

    /** Cria o contato ou atualiza o que já tem esse e-mail. */
    upsertContact(c) {
      db.prepare('INSERT INTO contacts (ts, name, email, stage, notes) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, stage = excluded.stage, notes = excluded.notes')
        .run(now(), c.name, c.email, c.stage, c.notes ?? '');
      return db.prepare('SELECT id, name, email, stage FROM contacts WHERE email = ?').get(c.email);
    },
    listContacts(stage) {
      return stage
        ? db.prepare('SELECT id, name, email, stage FROM contacts WHERE stage = ? ORDER BY name').all(stage)
        : db.prepare('SELECT id, name, email, stage FROM contacts ORDER BY name').all();
    },
    removeContact(id) { db.prepare('DELETE FROM contacts WHERE id = ?').run(id); },
    addCampaign(c) {
      return Number(db.prepare('INSERT INTO campaigns (ts, subject, body, audience) VALUES (?,?,?,?)').run(now(), c.subject, c.body, c.audience).lastInsertRowid);
    },
    listCampaigns() { return db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 100').all(); },
    removeCampaign(id) { db.prepare('DELETE FROM campaigns WHERE id = ?').run(id); },

    addAppointment(a) {
      const r = db.prepare('INSERT INTO agenda (start, end, title, notes, created) VALUES (?,?,?,?,?)').run(a.start, a.end, a.title, a.notes ?? '', now());
      return Number(r.lastInsertRowid);
    },
    getAppointment(id) {
      return db.prepare('SELECT * FROM agenda WHERE id = ?').get(id);
    },
    /** Compromissos que terminam depois de `from` e começam antes de `to`. */
    listAppointments(from, to, limit = 100) {
      return db.prepare('SELECT * FROM agenda WHERE end > ? AND start < ? ORDER BY start LIMIT ?').all(from, to, limit);
    },
    removeAppointment(id) {
      db.prepare('DELETE FROM agenda WHERE id = ?').run(id);
    },

    addFile(f) {
      db.prepare('INSERT INTO files (id, ts, name, mime, pages, text) VALUES (?,?,?,?,?,?)').run(f.id, now(), f.name, f.mime, f.pages, f.text);
    },
    getFile(id) {
      return db.prepare('SELECT * FROM files WHERE id = ?').get(String(id));
    },
    listFiles() {
      return db
        .prepare("SELECT id, ts, name, pages, LENGTH(text) AS chars, REPLACE(SUBSTR(text, 1, 160), char(10), ' ') AS preview FROM files ORDER BY ts DESC, rowid DESC")
        .all();
    },
    removeFile(id) {
      db.prepare('DELETE FROM files WHERE id = ?').run(String(id));
    },

    /** Data do registro mais antigo guardado (fala, evento ou documento), ou null se não há nenhum. */
    earliest() {
      const r = db.prepare('SELECT MIN(ts) AS ts FROM (SELECT MIN(ts) AS ts FROM turns UNION ALL SELECT MIN(ts) FROM events UNION ALL SELECT MIN(ts) FROM documents)').get();
      return r?.ts ?? null;
    },

    /** Quantas falas e quantos eventos estão guardados. */
    counts() {
      return {
        turns: db.prepare('SELECT COUNT(*) AS n FROM turns').get().n,
        events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
      };
    },

    /** true se este id já foi processado (o WhatsApp reenvia webhooks). */
    alreadySeen(id) {
      const r = db.prepare('INSERT OR IGNORE INTO seen (id, ts) VALUES (?, ?)').run(id, now());
      return r.changes === 0;
    },

    close() {
      db.close();
    },
  };
  return store;
}

/** Regras do dono: limite de escalonamento e instruções permanentes. */
export function getRules(store, config) {
  const saved = store.get('rules', {});
  return {
    threshold: saved.threshold ?? config.defaultThreshold,
    currency: saved.currency ?? config.currency,
    instructions: saved.instructions ?? [],
  };
}

export function setRules(store, config, patch) {
  const next = { ...getRules(store, config), ...patch };
  store.set('rules', next);
  return next;
}
