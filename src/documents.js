import PDFDocument from 'pdfkit';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { localTime } from './util.js';

// As fontes padrão do PDF cobrem o alfabeto latino (acentos incluídos), mas não emojis nem símbolos raros.
const clean = (s) =>
  String(s ?? '')
    .replace(/[‐‑]/g, '-')
    .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '')
    .replace(/[ \t]+$/gm, '');

/** Escreve um trecho com **negrito** embutido. */
function rich(doc, text, opts = {}) {
  const parts = text.replace(/`/g, '').split(/\*\*(.+?)\*\*/g);
  parts.forEach((part, i) => {
    if (!part && i < parts.length - 1) return;
    doc.font(i % 2 ? 'Helvetica-Bold' : 'Helvetica').text(part, { ...opts, continued: i < parts.length - 1 });
  });
}

/** Carrega o catálogo de imagens que podem entrar nos PDFs (knowledge/imagens/imagens.json) e o logo. */
export function loadImageLibrary(dir) {
  const lib = { logo: null, images: {} };
  if (!dir || !existsSync(dir)) return lib;
  const logo = join(dir, 'logo.png');
  if (existsSync(logo)) lib.logo = logo;
  const manifest = join(dir, 'imagens.json');
  if (existsSync(manifest)) {
    try {
      for (const it of JSON.parse(readFileSync(manifest, 'utf8'))) {
        const file = join(dir, String(it.arquivo));
        if (it.id && existsSync(file)) lib.images[String(it.id)] = { file, description: String(it.descricao ?? '') };
      }
    } catch {
      /* catálogo inválido: segue sem imagens */
    }
  }
  return lib;
}

/** Separa o markdown em blocos, isolando os gráficos (```grafico ... ```). */
function toBlocks(content) {
  const blocks = [];
  let chart = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (chart) {
      if (line.startsWith('```')) (blocks.push({ chart }), (chart = null));
      else if (line) chart.push(line);
    } else if (/^```\s*gr[aá]fico/i.test(line)) chart = [];
    else if (!line.startsWith('```')) blocks.push({ line });
  }
  if (chart) blocks.push({ chart });
  return blocks;
}

const fmtNumber = (n) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(n);

/** Monta um PDF A4 a partir de markdown simples (títulos, listas, negrito, parágrafos, imagens e gráficos). */
export function renderPdf({ title, content, business, dateLabel, library = { logo: null, images: {} }, accent = '#B08A3C' }) {
  return new Promise((resolve, reject) => {
    const M = 56;
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: clean(title), Author: clean(business) } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - M * 2;
    const INK = '#111111', MUTED = '#6b7280', RULE = '#d1d5db', ACCENT = accent;
    const bottom = () => doc.page.height - M;
    const need = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

    // Cabeçalho
    let titleW = W;
    if (library.logo) {
      try {
        const img = doc.openImage(library.logo);
        const h = 46, w = (img.width / img.height) * h;
        doc.image(img, M + W - w, M - 8, { height: h });
        titleW = W - w - 16;
      } catch { /* logo ilegível: segue sem */ }
    }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(clean(business).toUpperCase(), M, M, { characterSpacing: 2, width: titleW });
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text(clean(title), { lineGap: 2, width: titleW });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(clean(dateLabel), { width: titleW });
    doc.moveDown(0.8);
    const y = doc.y;
    doc.rect(M, y, 36, 2.5).fill(ACCENT);
    doc.rect(M + 36, y + 1, W - 36, 0.5).fill(RULE);
    doc.y = y + 18;
    doc.x = M;

    function drawImage(id, caption) {
      const entry = library.images[id];
      if (!entry) return false;
      let img;
      try { img = doc.openImage(entry.file); } catch { return false; }
      const w = W, h = (img.height / img.width) * w;
      need(h + 34);
      doc.moveDown(0.3);
      const top = doc.y;
      doc.image(img, M, top, { width: w });
      doc.rect(M, top, w, h).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.y = top + h + 6;
      if (caption) doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(caption, M, doc.y, { width: W, align: 'center' });
      doc.moveDown(0.8);
      doc.x = M;
      return true;
    }

    function drawChart(lines) {
      let chartTitle = '', unit = '';
      const rows = [];
      for (const l of lines) {
        const m = l.match(/^(.+?):\s*(.+)$/);
        if (!m) continue;
        const key = m[1].trim(), val = m[2].trim();
        if (/^t[ií]tulo$/i.test(key)) chartTitle = val;
        else if (/^unidade$/i.test(key)) unit = val;
        else {
          const n = Number(val.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
          if (Number.isFinite(n) && n >= 0) rows.push({ label: key.replace(/^[-*]\s*/, ''), value: n });
        }
      }
      if (!rows.length) return;
      const rowH = 20, labelW = 150, valueW = 78, barW = W - labelW - valueW - 8;
      need(rows.length * rowH + (chartTitle ? 46 : 26));
      doc.moveDown(0.4);
      if (chartTitle) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(chartTitle, M, doc.y, { width: W });
        doc.moveDown(0.5);
      }
      const max = Math.max(...rows.map((r) => r.value)) || 1;
      let top = doc.y;
      for (const r of rows) {
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(r.label, M, top + 5, { width: labelW - 8, height: 11, ellipsis: true, lineBreak: false });
        doc.rect(M + labelW, top + 3, barW, rowH - 8).fill('#f1f2f4');
        doc.rect(M + labelW, top + 3, Math.max(1.5, (r.value / max) * barW), rowH - 8).fill(ACCENT);
        const label = unit === 'R$' ? `R$ ${fmtNumber(r.value)}` : `${fmtNumber(r.value)}${unit ? ` ${unit}` : ''}`;
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(label, M + labelW + barW + 8, top + 5, { width: valueW, lineBreak: false });
        top += rowH;
      }
      doc.x = M;
      doc.y = top + 8;
    }

    // Corpo
    const body = { lineGap: 3.5, width: W };
    const blocks = toBlocks(clean(content));
    // Espaço que o bloco seguinte a um título vai pedir, para o título não ficar sozinho no pé da página.
    const followSpace = (i) => {
      const next = blocks.slice(i + 1).find((b) => b.chart || b.line);
      if (next?.chart) return next.chart.length * 20 + 50;
      if (next?.line && /^!\[/.test(next.line)) return W * 0.6 + 40;
      return 0;
    };
    for (const [i, block] of blocks.entries()) {
      if (block.chart) { drawChart(block.chart); continue; }
      const line = block.line;
      let m;
      if (!line) {
        doc.moveDown(0.45);
      } else if ((m = line.match(/^!\[(.*?)\]\((?:imagem:)?\s*([\w-]+)\s*\)$/i))) {
        if (!drawImage(m[2].toLowerCase(), m[1])) {
          doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(`(imagem "${m[2]}" indisponível)`, M, doc.y, { width: W });
        }
      } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        const size = [15, 12.5, 11][m[1].length - 1];
        need(60 + followSpace(i));
        doc.moveDown(m[1].length === 1 ? 0.7 : 0.4);
        doc.font('Helvetica-Bold').fontSize(size).fillColor(INK).text(m[2].replace(/\*\*/g, ''), M, doc.y, { width: W, lineGap: 2 });
        doc.moveDown(0.25);
      } else if ((m = line.match(/^([-*•]|\d+[.)])\s+(.*)$/))) {
        const mark = /^\d/.test(m[1]) ? m[1].replace(')', '.') : '•';
        need(16);
        const top = doc.y;
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(ACCENT).text(mark, M + 4, top, { width: 20, lineBreak: false });
        doc.fontSize(10.5).fillColor(INK);
        doc.x = M + 24;
        doc.y = top;
        rich(doc, m[2], { ...body, width: W - 24 });
        doc.x = M;
        doc.moveDown(0.15);
      } else if (/^([-_*])\1{2,}$/.test(line)) {
        doc.moveDown(0.3);
        doc.rect(M, doc.y, W, 0.5).fill(RULE);
        doc.moveDown(0.6);
      } else {
        doc.fontSize(10.5).fillColor(INK);
        doc.x = M;
        rich(doc, line, body);
        doc.moveDown(0.2);
      }
    }

    // Rodapé com numeração
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // senão escrever no rodapé abre página nova
      doc.font('Helvetica').fontSize(8).fillColor(MUTED);
      doc.text(clean(business), M, doc.page.height - 38, { width: W / 2, lineBreak: false });
      doc.text(`${i + 1} / ${range.count}`, M + W / 2, doc.page.height - 38, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

/** Guarda os PDFs no mesmo disco do banco e os serve por um endereço impossível de adivinhar. */
export function createDocuments({ store, dir, config }) {
  if (dir !== ':memory:') mkdirSync(dir, { recursive: true });
  const library = loadImageLibrary(join(config.knowledgeDir, 'imagens'));
  const mem = new Map();
  const path = (id) => join(dir, `${id}.pdf`);

  return {
    /** Imagens que o modelo pode citar no documento: [{ id, description }] */
    images: Object.entries(library.images).map(([id, v]) => ({ id, description: v.description })),

    async create({ title, content }) {
      const t = String(title ?? '').trim().slice(0, 140) || 'Documento';
      const body = String(content ?? '').trim();
      if (!body) throw new Error('conteúdo vazio');
      const buffer = await renderPdf({
        title: t,
        content: body,
        business: config.businessName,
        dateLabel: `${config.assistantName} · ${localTime(store.now(), config.timezone).label}`,
        library,
        accent: config.pdfAccent,
      });
      const id = randomBytes(16).toString('base64url');
      if (dir === ':memory:') mem.set(id, buffer);
      else writeFileSync(path(id), buffer);
      store.addDocument(id, t);
      return { id, title: t, url: `/d/${id}.pdf`, buffer, filename: this.filename(t) };
    },

    read(id) {
      const meta = store.getDocument(id);
      if (!meta) return null;
      const buffer = dir === ':memory:' ? mem.get(id) : existsSync(path(id)) ? readFileSync(path(id)) : null;
      return buffer ? { title: meta.title, buffer, filename: this.filename(meta.title) } : null;
    },

    list(limit = 30) {
      return store.listDocuments(limit).map((d) => ({ id: d.id, title: d.title, ts: d.ts, url: `/d/${d.id}.pdf` }));
    },

    filename(title) {
      const slug = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      return `${slug || 'documento'}.pdf`;
    },
  };
}
