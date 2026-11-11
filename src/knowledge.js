import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Base de conhecimento = arquivos .md/.txt da pasta knowledge/ + notas que o dono ditou
 * (guardadas no banco). É o que o Jarvis usa para responder clientes e membros.
 */
export function loadKnowledge(dir, store) {
  const parts = [];
  if (dir && existsSync(dir)) {
    const files = readdirSync(dir)
      .filter((f) => /\.(md|txt)$/i.test(f))
      .sort();
    for (const f of files) {
      const body = readFileSync(join(dir, f), 'utf8').trim();
      if (body) parts.push(`## Arquivo: ${f}\n\n${body}`);
    }
  }
  const notes = store?.get('notes', []) ?? [];
  if (notes.length) {
    parts.push(`## Notas ditadas pelo dono\n\n${notes.map((n) => `- ${n.text}`).join('\n')}`);
  }
  return parts.join('\n\n---\n\n');
}

export function addNote(store, text) {
  const notes = store.get('notes', []);
  notes.push({ ts: store.now(), text: String(text).trim() });
  store.set('notes', notes);
  return notes.length;
}
