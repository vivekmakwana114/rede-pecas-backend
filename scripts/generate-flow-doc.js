// Regenerates the client-facing "Rede Pecas - WhatsApp Conversation Script"
// in two formats from the single content source in flow-content.js:
//   - rede-pecas-flow.pdf   (readable document)
//   - rede-pecas-flow.docx  (editable Word document, same content)
//
// Usage: node scripts/generate-flow-doc.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, VerticalAlign,
} from 'docx';
import { meta, stages } from './flow-content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..');

const NAVY = '#1A3A5C';
const BLUE = '#2E6DA4';
const INK = '#222222';
const GRAY = '#666666';
const LIGHT_GRAY = '#999999';
const SYSTEM_BG = '#F3F6FA';
const SYSTEM_BORDER = '#DCE4EC';
const CUSTOMER_BG = '#E9F5EC';
const CUSTOMER_BORDER = '#C9E4CF';
const NOTE_ACCENT = '#D9A441';
const NOTE_BG = '#FFFBF2';

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

function ensureSpace(doc, height) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) {
    doc.addPage();
  }
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function drawTitlePage(doc) {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);

  doc.font('Helvetica-Bold').fontSize(28).fillColor(NAVY).text(meta.docTitle, x, 90);
  doc.font('Helvetica').fontSize(18).fillColor(BLUE).text(meta.docSubtitle, x, 128);
  doc.moveTo(x, 165).lineTo(x + width, 165).strokeColor(BLUE).lineWidth(2).stroke();

  doc.y = 185;
  doc.font('Helvetica').fontSize(10.5).fillColor(GRAY);
  for (const line of meta.intro) {
    doc.text(line, x, doc.y, { width });
    doc.moveDown(0.3);
  }

  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('How to read this document', x, doc.y);
  doc.moveDown(0.5);
  for (const [label, description] of meta.legend) {
    const labelWidth = 110;
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BLUE).text(label, x + 10, y, { width: labelWidth });
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
      .text(description, x + 10 + labelWidth, y, { width: width - labelWidth - 10 });
    doc.y = Math.max(doc.y, y + 14) + 4;
  }

  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Contents', x, doc.y);
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  stages.forEach((stage, i) => {
    doc.text(`${i + 1}. ${stage.title}`, x + 10, doc.y);
    doc.moveDown(0.25);
  });
}

// Stages only force a fresh page when the current one doesn't have enough
// room left for the header + intro + a first block - otherwise they continue
// on the same page behind a rule. This is what stops a stage's last leftover
// note (e.g. the NIF branch, or an "invalid year" aside) from being stranded
// alone on an otherwise-empty page just because the *next* stage always
// wanted a clean start.
const STAGE_HEADER_MIN_SPACE = 170;

function drawStageHeader(doc, stage, { first } = {}) {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  const bottom = doc.page.height - doc.page.margins.bottom;

  if (first || doc.y + STAGE_HEADER_MIN_SPACE > bottom) {
    doc.addPage();
  } else {
    doc.moveDown(1.4);
    doc.moveTo(x, doc.y).lineTo(x + width, doc.y).strokeColor('#DDDDDD').lineWidth(1).stroke();
    doc.moveDown(1.2);
  }

  const barHeight = 32;
  const y = doc.y;

  doc.rect(x, y, width, barHeight).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#FFFFFF')
    .text(`${stage.id}   ${stage.title}`, x + 12, y + 9, { width: width - 24 });
  doc.y = y + barHeight + 10;

  doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(GRAY)
    .text(stage.intro, x, doc.y, { width });
  doc.moveDown(1);
}

function drawSubhead(doc, text) {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  doc.font('Helvetica-Bold').fontSize(10.5);
  const h = doc.heightOfString(text, { width });
  ensureSpace(doc, h + 20);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(BLUE).text(text, x, doc.y, { width });
  doc.moveDown(0.4);
}

function drawMessageBlock(doc, text, { align, bg, border, label, labelColor, textColor }) {
  const x = doc.page.margins.left;
  const fullWidth = contentWidth(doc);
  const boxWidth = Math.round(fullWidth * 0.78);
  const boxX = align === 'right' ? x + fullWidth - boxWidth : x;
  const padX = 12;
  const padY = 8;

  doc.font('Helvetica').fontSize(9.5);
  const textHeight = doc.heightOfString(text, { width: boxWidth - padX * 2 });
  const boxHeight = textHeight + padY * 2;
  const labelHeight = 13;
  ensureSpace(doc, labelHeight + boxHeight + 10);

  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(labelColor)
    .text(label, boxX, y, { width: boxWidth, align: align === 'right' ? 'right' : 'left', characterSpacing: 0.5 });

  const boxY = y + labelHeight;
  doc.roundedRect(boxX, boxY, boxWidth, boxHeight, 6).fillAndStroke(bg, border);
  doc.font('Helvetica').fontSize(9.5).fillColor(textColor)
    .text(text, boxX + padX, boxY + padY, { width: boxWidth - padX * 2 });

  doc.y = boxY + boxHeight + 8;
}

function drawSystem(doc, text) {
  drawMessageBlock(doc, text, {
    align: 'left', bg: SYSTEM_BG, border: SYSTEM_BORDER,
    label: 'SYSTEM', labelColor: BLUE, textColor: INK,
  });
}

function drawCustomer(doc, text) {
  drawMessageBlock(doc, text, {
    align: 'right', bg: CUSTOMER_BG, border: CUSTOMER_BORDER,
    label: 'CUSTOMER', labelColor: '#2E7D46', textColor: INK,
  });
}

function drawButtons(doc, items) {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  const gap = 8;
  const padX = 10;
  const pillHeight = 20;

  doc.font('Helvetica').fontSize(8.5);
  ensureSpace(doc, pillHeight + 16);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(LIGHT_GRAY).text('Buttons shown:', x, doc.y);
  doc.moveDown(0.3);

  let cx = x;
  let cy = doc.y;
  for (const item of items) {
    doc.font('Helvetica').fontSize(8.5);
    const w = doc.widthOfString(item) + padX * 2 + 2;
    if (cx + w > x + width) {
      cx = x;
      cy += pillHeight + 6;
    }
    if (cy + pillHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      cy = doc.y;
      cx = x;
    }
    doc.roundedRect(cx, cy, w, pillHeight, 10).strokeColor(BLUE).lineWidth(1).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(BLUE)
      .text(item, cx + padX, cy + 5.5, { width: w - padX * 2, lineBreak: false });
    cx += w + gap;
  }
  doc.y = cy + pillHeight + 10;
}

function drawNote(doc, text) {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  const padX = 10;
  const padY = 6;
  const barWidth = 3;

  doc.font('Helvetica-Oblique').fontSize(8.5);
  const textHeight = doc.heightOfString(text, { width: width - barWidth - padX * 2 });
  const boxHeight = textHeight + padY * 2;
  ensureSpace(doc, boxHeight + 10);

  const y = doc.y;
  doc.rect(x, y, width, boxHeight).fill(NOTE_BG);
  doc.rect(x, y, barWidth, boxHeight).fill(NOTE_ACCENT);
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(GRAY)
    .text(text, x + barWidth + padX, y + padY, { width: width - barWidth - padX * 2 });
  doc.y = y + boxHeight + 10;
}

function drawTable(doc, headers, rows) {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  const colWidths = [0.22, 0.18, 0.12, 0.48].map((f) => Math.round(width * f));
  const padX = 6;
  const padY = 5;

  function rowHeight(cells, font, size) {
    doc.font(font).fontSize(size);
    return Math.max(
      ...cells.map((c, i) => doc.heightOfString(String(c), { width: colWidths[i] - padX * 2 }))
    ) + padY * 2;
  }

  ensureSpace(doc, rowHeight(headers, 'Helvetica-Bold', 8.5) + 10);
  let y = doc.y;
  let h = rowHeight(headers, 'Helvetica-Bold', 8.5);
  doc.rect(x, y, width, h).fill(NAVY);
  let cx = x;
  headers.forEach((hd, i) => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF')
      .text(hd, cx + padX, y + padY, { width: colWidths[i] - padX * 2 });
    cx += colWidths[i];
  });
  y += h;
  doc.y = y;

  rows.forEach((row, idx) => {
    const rh = rowHeight(row, 'Helvetica', 8.5);
    ensureSpace(doc, rh);
    y = doc.y;
    doc.rect(x, y, width, rh).fill(idx % 2 === 0 ? '#F7F9FB' : '#FFFFFF');
    let cx2 = x;
    row.forEach((cell, i) => {
      doc.font('Helvetica').fontSize(8.5).fillColor(INK)
        .text(String(cell), cx2 + padX, y + padY, { width: colWidths[i] - padX * 2 });
      cx2 += colWidths[i];
    });
    doc.y = y + rh;
  });
  doc.moveDown(1);
}

function renderBlock(doc, block) {
  switch (block.t) {
    case 'system': return drawSystem(doc, block.text);
    case 'customer': return drawCustomer(doc, block.text);
    case 'buttons': return drawButtons(doc, block.items);
    case 'note': return drawNote(doc, block.text);
    case 'subhead': return drawSubhead(doc, block.text);
    case 'table': return drawTable(doc, block.headers, block.rows);
    default: throw new Error(`Unknown block type: ${block.t}`);
  }
}

function generatePDF(outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    drawTitlePage(doc);
    stages.forEach((stage, i) => {
      drawStageHeader(doc, stage, { first: i === 0 });
      for (const block of stage.blocks) {
        renderBlock(doc, block);
      }
    });

    doc.end();
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// DOCX rendering (editable Word document, same content as the PDF)
// ---------------------------------------------------------------------------

const DX = {
  navy: '1A3A5C',
  blue: '2E6DA4',
  ink: '222222',
  gray: '666666',
  lightGray: '999999',
  systemBg: 'F3F6FA',
  systemBorder: 'DCE4EC',
  customerBg: 'E9F5EC',
  customerBorder: 'C9E4CF',
  customerLabel: '2E7D46',
  noteAccent: 'D9A441',
  noteBg: 'FFFBF2',
};

// docx TextRun doesn't honor literal "\n" - each line needs its own run with
// an explicit break, so a multi-line message still renders as one paragraph
// (required for the background shading to wrap the whole block, not just the
// first line).
function multilineRuns(text, runOpts, { leadingBreak = false } = {}) {
  return text.split('\n').map((line, i) => new TextRun({
    text: line,
    break: i > 0 || leadingBreak ? 1 : 0,
    ...runOpts,
  }));
}

function allSidesBorder(color) {
  const side = { style: BorderStyle.SINGLE, size: 2, color };
  return { top: side, bottom: side, left: side, right: side };
}

function docxStageHeader(stage) {
  return [
    new Paragraph({
      pageBreakBefore: true,
      shading: { type: ShadingType.CLEAR, fill: DX.navy },
      spacing: { before: 0, after: 0 },
      children: [new TextRun({ text: `${stage.id}   ${stage.title}`, bold: true, color: 'FFFFFF', size: 26 })],
    }),
    new Paragraph({
      spacing: { before: 120, after: 200 },
      children: [new TextRun({ text: stage.intro, italics: true, color: DX.gray, size: 19 })],
    }),
  ];
}

function docxSubhead(text) {
  return new Paragraph({
    spacing: { before: 220, after: 100 },
    children: [new TextRun({ text, bold: true, color: DX.blue, size: 21 })],
  });
}

function docxSystem(text) {
  return new Paragraph({
    spacing: { before: 100, after: 100 },
    shading: { type: ShadingType.CLEAR, fill: DX.systemBg },
    border: allSidesBorder(DX.systemBorder),
    children: [
      new TextRun({ text: 'SYSTEM', bold: true, color: DX.blue, size: 15 }),
      ...multilineRuns(text, { color: DX.ink, size: 19 }, { leadingBreak: true }),
    ],
  });
}

function docxCustomer(text) {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { before: 100, after: 100 },
    shading: { type: ShadingType.CLEAR, fill: DX.customerBg },
    border: allSidesBorder(DX.customerBorder),
    children: [
      new TextRun({ text: 'CUSTOMER', bold: true, color: DX.customerLabel, size: 15 }),
      ...multilineRuns(text, { color: DX.ink, size: 19 }, { leadingBreak: true }),
    ],
  });
}

function docxButtons(items) {
  return new Paragraph({
    spacing: { before: 40, after: 140 },
    children: [
      new TextRun({ text: 'Buttons shown: ', italics: true, color: DX.lightGray, size: 17 }),
      new TextRun({ text: items.join('   |   '), italics: true, bold: true, color: DX.blue, size: 17 }),
    ],
  });
}

function docxNote(text) {
  return new Paragraph({
    spacing: { before: 100, after: 140 },
    shading: { type: ShadingType.CLEAR, fill: DX.noteBg },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: DX.noteAccent } },
    indent: { left: 150 },
    children: multilineRuns(text, { italics: true, color: DX.gray, size: 17 }),
  });
}

function docxCell(text, { header = false, shade } = {}) {
  return new TableCell({
    width: { size: 25, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    shading: header ? { fill: DX.navy } : shade ? { fill: shade } : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({
      children: [new TextRun({ text: String(text), bold: header, color: header ? 'FFFFFF' : DX.ink, size: 17 })],
    })],
  });
}

function docxTable(headers, rows) {
  const colWidths = [22, 18, 12, 48];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: headers.map((h, i) => new TableCell({
          width: { size: colWidths[i], type: WidthType.PERCENTAGE },
          verticalAlign: VerticalAlign.CENTER,
          shading: { fill: DX.navy },
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 17 })] })],
        })),
      }),
      ...rows.map((row, idx) => new TableRow({
        children: row.map((cell, i) => new TableCell({
          width: { size: colWidths[i], type: WidthType.PERCENTAGE },
          verticalAlign: VerticalAlign.CENTER,
          shading: { fill: idx % 2 === 0 ? 'F7F9FB' : 'FFFFFF' },
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          children: [new Paragraph({ children: [new TextRun({ text: String(cell), size: 17 })] })],
        })),
      })),
    ],
  });
}

function docxBlock(block) {
  switch (block.t) {
    case 'system': return docxSystem(block.text);
    case 'customer': return docxCustomer(block.text);
    case 'buttons': return docxButtons(block.items);
    case 'note': return docxNote(block.text);
    case 'subhead': return docxSubhead(block.text);
    case 'table': return docxTable(block.headers, block.rows);
    default: throw new Error(`Unknown block type: ${block.t}`);
  }
}

function buildTitlePageChildren() {
  const children = [
    new Paragraph({ children: [new TextRun({ text: meta.docTitle, bold: true, color: DX.navy, size: 56 })] }),
    new Paragraph({
      spacing: { before: 60, after: 200 },
      children: [new TextRun({ text: meta.docSubtitle, bold: true, color: DX.blue, size: 36 })],
    }),
  ];
  for (const line of meta.intro) {
    children.push(new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: line, color: DX.gray, size: 21 })],
    }));
  }

  children.push(new Paragraph({
    spacing: { before: 260, after: 140 },
    children: [new TextRun({ text: 'How to read this document', bold: true, color: DX.navy, size: 24 })],
  }));
  for (const [label, description] of meta.legend) {
    children.push(new Paragraph({
      spacing: { after: 80 },
      indent: { left: 200 },
      children: [
        new TextRun({ text: `${label}: `, bold: true, color: DX.blue, size: 19 }),
        new TextRun({ text: description, color: DX.ink, size: 19 }),
      ],
    }));
  }

  children.push(new Paragraph({
    spacing: { before: 260, after: 140 },
    children: [new TextRun({ text: 'Contents', bold: true, color: DX.navy, size: 24 })],
  }));
  stages.forEach((stage, i) => {
    children.push(new Paragraph({
      spacing: { after: 60 },
      indent: { left: 200 },
      children: [new TextRun({ text: `${i + 1}. ${stage.title}`, color: DX.ink, size: 19 })],
    }));
  });

  return children;
}

async function generateDOCX(outPath) {
  const children = [...buildTitlePageChildren()];
  for (const stage of stages) {
    children.push(...docxStageHeader(stage));
    for (const block of stage.blocks) {
      children.push(docxBlock(block));
    }
  }

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

// ---------------------------------------------------------------------------

const pdfPath = path.join(OUT_DIR, 'rede-pecas-flow.pdf');
const docxPath = path.join(OUT_DIR, 'rede-pecas-flow.docx');

await generatePDF(pdfPath);
await generateDOCX(docxPath);

console.log(`Generated: ${pdfPath}`);
console.log(`Generated: ${docxPath}`);
