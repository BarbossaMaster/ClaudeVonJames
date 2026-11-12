import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-ndjson))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|log|ya?ml)$/i;

/** Extrai o texto de um arquivo enviado. Aceita PDF e formatos de texto. */
export async function extractText(buffer, name, mime = '') {
  if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) {
    // Importado pelo caminho interno: o ponto de entrada do pacote roda um autoteste ao ser carregado.
    const pdf = createRequire(import.meta.url)('pdf-parse/lib/pdf-parse.js');
    const out = await pdf(buffer);
    return { text: out.text, pages: out.numpages };
  }
  if (TEXT_TYPES.test(mime) || TEXT_EXT.test(name)) return { text: buffer.toString('utf8') };
  throw new Error('formato não aceito: envie PDF ou texto (txt, md, csv, json)');
}

const clean = (t) => t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Arquivos que o dono envia para o assistente consultar. O texto fica no banco; o assistente
 * recebe só o índice (nome e começo de cada arquivo) e busca ou lê o conteúdo quando precisa.
 * Assim dá para guardar muito material sem encarecer cada resposta.
 */
export function createFiles({ store }) {
  return {
    async add(buffer, name, mime) {
      const safe = String(name || 'arquivo').replace(/[\\/\0]/g, '_').slice(0, 120);
      const { text, pages } = await extractText(buffer, safe, mime);
      const body = clean(text);
      if (body.length < 20) throw new Error('não encontrei texto nesse arquivo (PDF digitalizado como imagem ainda não é lido)');
      const id = randomBytes(6).toString('base64url');
      store.addFile({ id, name: safe, mime: mime || '', pages: pages ?? null, text: body });
      return { id, name: safe, chars: body.length, pages: pages ?? null };
    },

    list() { return store.listFiles(); },
    remove(id) { store.removeFile(id); },

    /** Índice curto para o prompt: uma linha por arquivo. */
    index() {
      return store.listFiles().map((f) => `- [${f.id}] ${f.name} (${f.pages ? f.pages + ' páginas, ' : ''}${f.chars} caracteres): ${f.preview}`).join('\n');
    },

    /** Lê um trecho do arquivo, a partir de `from`. */
    read(id, from = 0, size = 12000) {
      const f = store.getFile(id);
      if (!f) throw new Error(`arquivo ${id} não existe`);
      const start = Math.max(0, Number(from) || 0);
      const text = f.text.slice(start, start + size);
      return { id: f.id, name: f.name, from: start, to: start + text.length, total: f.text.length, more: start + text.length < f.text.length, text };
    },

    /** Busca por palavras em todos os arquivos; devolve os trechos em volta de cada ocorrência. */
    search(query, limit = 8) {
      const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const terms = norm(String(query ?? '')).split(/\s+/).filter((t) => t.length > 2);
      if (!terms.length) return [];
      const hits = [];
      for (const meta of store.listFiles()) {
        const f = store.getFile(meta.id), low = norm(f.text);
        const seen = [];
        for (const term of terms) {
          let pos = low.indexOf(term);
          while (pos !== -1 && seen.length < 40) { seen.push(pos); pos = low.indexOf(term, pos + term.length); }
        }
        seen.sort((a, b) => a - b);
        let last = -1e9;
        for (const pos of seen) {
          if (pos - last < 500) continue; // não repete trechos que se sobrepõem
          last = pos;
          const from = Math.max(0, pos - 200);
          const snippet = f.text.slice(from, pos + 500);
          const score = terms.filter((t) => norm(snippet).includes(t)).length;
          hits.push({ id: f.id, name: f.name, from, score, snippet });
        }
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...h }) => h);
    },
  };
}
