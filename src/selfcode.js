import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync, cpSync, symlinkSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative, sep } from 'node:path';

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

// A própria trava, os testes e a configuração de publicação ficam fora do alcance dele.
const LOCKED = /^(src\/selfcode\.js|src\/server\.js|test\/)/;

const run = (args, cwd) => execFileSync(process.execPath, args, {
  cwd, stdio: 'pipe', timeout: 120000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', JAMES_REHEARSAL: '1' }, // sem chaves nem banco de verdade
});
const why = (e) => String(e.stdout || '').split('\n').filter((l) => /^not ok|error:|Error/.test(l.trim())).concat(String(e.stderr || e.message).split('\n')).filter(Boolean).slice(0, 5).join(' | ').slice(0, 400);

/**
 * Ensaio antes de gravar: monta uma cópia do sistema com a mudança aplicada e só deixa passar se
 * (1) todo o código tiver sintaxe válida, inclusive o da tela, e (2) todos os testes passarem.
 * Qualquer falha lança erro e nada é gravado.
 */
function rehearse(path, text) {
  const dir = mkdtempSync(join(tmpdir(), 'james-'));
  try {
    cpSync(ROOT, dir, { recursive: true, filter: (src) => { const n = relative(ROOT, src).split(sep)[0]; return !SKIP.has(n) && !n.startsWith('.env'); } });
    if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    try {
      if (/\.(js|mjs)$/.test(path)) run(['--check', path], dir);
      if (/\.html$/.test(path)) {
        const scripts = [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        if (path === 'public/index.html' && !scripts.length) throw new Error('a tela ficaria sem o seu programa');
        scripts.forEach((code, i) => { const f = `.check-${i}.cjs`; writeFileSync(join(dir, f), code); run(['--check', f], dir); });
      }
    } catch (e) { throw new Error(`a mudança deixaria ${path} com erro de sintaxe, nada foi gravado: ${why(e)}`); }
    if (existsSync(join(dir, 'test')) && !process.env.JAMES_REHEARSAL) {
      try { run(['--disable-warning=ExperimentalWarning', '--test', 'test/*.test.js'], dir); }
      catch (e) { throw new Error(`a mudança quebra os testes do sistema, nada foi gravado: ${why(e)}`); }
    }
    // Por último liga o sistema de verdade na cópia (banco vazio, sem chaves) e exige que ele responda.
    if (!process.env.JAMES_REHEARSAL) {
      try { run(['-e', BOOT], dir); }
      catch (e) { throw new Error(`com a mudança o sistema não liga, nada foi gravado: ${why(e)}`); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Sobe o servidor da cópia numa porta livre e espera o /health e a tela responderem.
const BOOT = `
const { spawn } = require('node:child_process');
const port = 20000 + Math.floor(Math.random() * 20000);
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), JARVIS_DB: '.boot/check.db', JARVIS_TOKEN: 'ensaio', BRIEFING_HOUR: '99' }, stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; srv.stderr.on('data', (d) => { err += d; });
const end = (code, msg) => { srv.kill('SIGKILL'); if (msg) console.error(msg); process.exit(code); };
srv.on('exit', (c) => end(1, 'o servidor caiu ao ligar: ' + err.split('\\n').filter(Boolean).slice(-3).join(' | ')));
const t0 = Date.now();
(async function poll() {
  try {
    const h = await fetch('http://127.0.0.1:' + port + '/health'); const page = await fetch('http://127.0.0.1:' + port + '/');
    const st = await fetch('http://127.0.0.1:' + port + '/api/state', { headers: { Authorization: 'Bearer ensaio' } });
    if (h.ok && page.ok && st.ok) return end(0);
    return end(1, 'respostas erradas ao ligar: health ' + h.status + ', tela ' + page.status + ', estado ' + st.status);
  } catch { if (Date.now() - t0 > 20000) return end(1, 'o servidor não respondeu em 20 segundos'); setTimeout(poll, 300); }
})();
`;

export function createSelfCode({ github = {}, fetchImpl = fetch, store = null, backup = null, check = rehearse } = {}) {
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
    if (LOCKED.test(p)) throw new Error(`${p} é parte da trava de segurança e só o desenvolvedor altera`);
    return p;
  };
  const commit = async (p, text, message, sha, previous = null) => {
    check(p, text); // ensaio completo; se falhar, para aqui
    const copia = backup ? backup() : null; // cópia dos dados antes de qualquer mudança no ar
    const res = await api(p, { method: 'PUT', body: JSON.stringify({ message: String(message || `Ajuste em ${p}`).slice(0, 200), content: Buffer.from(text).toString('base64'), branch: github.branch, ...(sha ? { sha } : {}) }) });
    if (!res.ok) throw new Error(`o GitHub recusou a gravação (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    store?.set('selfcode_last', JSON.stringify({ path: p, previous, at: Date.now() }));
    return { saved: p, ensaio: 'sintaxe e testes passaram', copia_dos_dados: copia || undefined, commit: j.commit?.sha?.slice(0, 7), note: 'gravado; o servidor republica sozinho em um ou dois minutos e a mudança passa a valer depois disso' };
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
      return commit(p, text.replace(find, () => String(replace ?? '')), message, j.sha, text);
    },

    /** Desfaz a última alteração feita por ele: devolve o arquivo ao que era (ou apaga o que foi criado). */
    async undo() {
      const last = JSON.parse(store?.get('selfcode_last') || 'null');
      if (!last) throw new Error('não há alteração minha para desfazer');
      const res = await api(`${last.path}?ref=${encodeURIComponent(github.branch)}`);
      if (!res.ok) throw new Error(`não consegui ler ${last.path} no repositório (${res.status})`);
      const sha = (await res.json()).sha;
      const body = { message: `Desfaz a última alteração em ${last.path}`, branch: github.branch, sha };
      if (last.previous !== null) body.content = Buffer.from(last.previous).toString('base64');
      const out = await api(last.path, { method: last.previous === null ? 'DELETE' : 'PUT', body: JSON.stringify(body) });
      if (!out.ok) throw new Error(`o GitHub recusou (${out.status}): ${(await out.text()).slice(0, 200)}`);
      store?.set('selfcode_last', 'null');
      return { undone: last.path, note: 'desfeito; o servidor republica sozinho em um ou dois minutos' };
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
