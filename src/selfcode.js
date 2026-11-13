import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, normalize, relative, sep } from 'node:path';

/**
 * Acesso do assistente ao próprio código: listar, ler e procurar; e, com um token do GitHub, alterar.
 * A alteração vira um commit no repositório (o servidor republica sozinho), então tudo fica no histórico e pode ser desfeito.
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

const WRITABLE = /^(src|public|knowledge|docs|test)\/[\w./-]+$|^README\.md$/;

/** Confere a sintaxe de um arquivo .js antes de gravar, para ele não se derrubar com um erro de digitação. */
function checkSyntax(path, text) {
  if (!/\.(js|mjs)$/.test(path)) return;
  const dir = mkdtempSync(join(tmpdir(), 'james-'));
  try {
    const file = join(dir, 'check.mjs');
    writeFileSync(file, text);
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', timeout: 15000 });
  } catch (e) {
    throw new Error(`a mudança deixaria o arquivo com erro de sintaxe, nada foi gravado: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 300)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function createSelfCode({ github = {}, fetchImpl = fetch } = {}) {
  const api = async (path, init = {}) => {
    if (!github.token) throw new Error('alterar o código ainda não está liberado: falta a variável GITHUB_TOKEN no servidor');
    const res = await fetchImpl(`https://api.github.com/repos/${github.repo}/contents/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'assistant-selfcode', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    return res;
  };
  const safe = (path) => {
    const p = String(path ?? '').replace(/^\/+/, '');
    if (!WRITABLE.test(p) || p.includes('..') || !TEXT.test(p)) throw new Error(`não posso gravar em ${path}: só em src/, public/, knowledge/, docs/, test/ e README.md`);
    return p;
  };
  const commit = async (p, text, message, sha) => {
    checkSyntax(p, text);
    const res = await api(p, { method: 'PUT', body: JSON.stringify({ message: String(message || `Ajuste em ${p}`).slice(0, 200), content: Buffer.from(text).toString('base64'), branch: github.branch, ...(sha ? { sha } : {}) }) });
    if (!res.ok) throw new Error(`o GitHub recusou a gravação (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return { saved: p, commit: j.commit?.sha?.slice(0, 7), note: 'gravado; o servidor republica sozinho em um ou dois minutos e a mudança passa a valer depois disso' };
  };
  return {
    canWrite: Boolean(github.token),

    /** Troca um trecho exato por outro. O trecho precisa aparecer uma única vez no arquivo. */
    async edit(path, find, replace, message) {
      const p = safe(path);
      if (!find) throw new Error('faltou o trecho a substituir (find)');
      const res = await api(`${p}?ref=${encodeURIComponent(github.branch)}`);
      if (!res.ok) throw new Error(`não consegui ler ${p} no repositório (${res.status})`);
      const j = await res.json();
      const text = Buffer.from(j.content, 'base64').toString('utf8');
      const n = text.split(find).length - 1;
      if (n !== 1) throw new Error(n ? `o trecho aparece ${n} vezes em ${p}; inclua mais contexto para ficar único` : `o trecho não foi encontrado em ${p}; leia o arquivo de novo e copie o texto exato`);
      return commit(p, text.replace(find, () => String(replace ?? '')), message, j.sha);
    },

    /** Cria um arquivo novo (não sobrescreve um existente). */
    async create(path, content, message) {
      const p = safe(path);
      const res = await api(`${p}?ref=${encodeURIComponent(github.branch)}`);
      if (res.ok) throw new Error(`${p} já existe; use a ação edit`);
      return commit(p, String(content ?? ''), message);
    },

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
