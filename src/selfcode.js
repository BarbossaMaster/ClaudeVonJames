import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, normalize, relative, sep } from 'node:path';

/**
 * Acesso do assistente ao próprio código, só para leitura: listar, ler e procurar.
 * Ficam de fora os segredos e os dados (.env, data/), as dependências e o histórico do git.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', 'data', '.git', '.env']);
const TEXT = /\.(js|mjs|cjs|json|md|html|css|svg|txt|webmanifest|example|gitignore)$/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.startsWith('.env')) continue;
    const full = join(dir, name), st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEXT.test(name) && name !== 'package-lock.json') out.push({ path: relative(ROOT, full).split(sep).join('/'), bytes: st.size });
  }
  return out;
}

function resolve(path) {
  const rel = normalize(String(path ?? '')).replace(/^([/\\])+/, '');
  const hit = walk(ROOT).find((f) => f.path === rel.split(sep).join('/'));
  if (!hit) throw new Error(`arquivo não encontrado ou fora do alcance: ${path}. Use a ação "list" para ver os caminhos.`);
  return join(ROOT, hit.path);
}

export function createSelfCode() {
  return {
    list() { return walk(ROOT).map((f) => ({ path: f.path, lines: readFileSync(join(ROOT, f.path), 'utf8').split('\n').length })); },

    /** Lê até 250 linhas a partir de from_line (1 = primeira). */
    read(path, fromLine = 1) {
      const lines = readFileSync(resolve(path), 'utf8').split('\n');
      const start = Math.max(1, Number(fromLine) || 1), chunk = lines.slice(start - 1, start - 1 + 250);
      return { path, from_line: start, to_line: start + chunk.length - 1, total_lines: lines.length, more: start - 1 + chunk.length < lines.length, text: chunk.map((l) => l.slice(0, 400)).join('\n') };
    },

    /** Procura um texto em todos os arquivos; devolve arquivo, linha e o trecho. */
    search(query, limit = 40) {
      const q = String(query ?? '').toLowerCase().trim();
      if (q.length < 2) throw new Error('busca curta demais');
      const hits = [];
      for (const f of walk(ROOT)) {
        const lines = readFileSync(join(ROOT, f.path), 'utf8').split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i++) if (lines[i].toLowerCase().includes(q)) hits.push({ path: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (hits.length >= limit) break;
      }
      return hits;
    },
  };
}
