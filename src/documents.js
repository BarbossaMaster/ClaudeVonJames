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

/** Monta um PDF A4 a partir de markdown simples (títulos, listas, negrito, parágrafos). */
export function renderPdf({ title, content, business, dateLabel }) {
  return new Promise((resolve, reject) => {
    const M = 56;
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: clean(title), Author: clean(business) } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - M * 2;
    const INK = '#111111', MUTED = '#6b7280', ACCENT = '#16a34a';

    // Cabeçalho
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(clean(business).toUpperCase(), { characterSpacing: 2 });
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text(clean(title), { lineGap: 2 });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(clean(dateLabel));
    doc.moveDown(0.8);
    const y = doc.y;
    doc.rect(M, y, 36, 2.5).fill(ACCENT);
    doc.rect(M + 36, y + 1, W - 36, 0.5).fill('#d1d5db');
    doc.y = y + 18;

    // Corpo
    const body = { lineGap: 3.5, width: W };
    for (const raw of clean(content).split('\n')) {
      const line = raw.trim();
      let m;
      if (!line) {
        doc.moveDown(0.45);
      } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        const size = [15, 12.5, 11][m[1].length - 1];
        if (doc.y > doc.page.height - M - 60) doc.addPage();
        doc.moveDown(m[1].length === 1 ? 0.7 : 0.4);
        doc.font('Helvetica-Bold').fontSize(size).fillColor(INK).text(m[2].replace(/\*\*/g, ''), { width: W, lineGap: 2 });
        doc.moveDown(0.25);
      } else if ((m = line.match(/^([-*•]|\d+[.)])\s+(.*)$/))) {
        const mark = /^\d/.test(m[1]) ? m[1].replace(')', '.') : '•';
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
        doc.rect(M, doc.y, W, 0.5).fill('#d1d5db');
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
  const mem = new Map();
  const path = (id) => join(dir, `${id}.pdf`);

  return {
    async create({ title, content }) {
      const t = String(title ?? '').trim().slice(0, 140) || 'Documento';
      const body = String(content ?? '').trim();
      if (!body) throw new Error('conteúdo vazio');
      const buffer = await renderPdf({
        title: t,
        content: body,
        business: config.businessName,
        dateLabel: `${config.assistantName} · ${localTime(store.now(), config.timezone).label}`,
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
