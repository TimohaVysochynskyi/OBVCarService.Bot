import { createRequire } from 'module';
import PDFDocument from 'pdfkit';

// ESM has no require.resolve; use createRequire to locate the bundled Cyrillic-capable fonts.
const require = createRequire(import.meta.url);
const FONT_REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const COLOR_HEADING = '#1a3d7c';
const COLOR_TEXT = '#1a1a1a';
const COLOR_MUTED = '#888888';
const COLOR_RULE = '#d9d9d9';

// The analysis output uses standalone, fully-uppercase lines for section titles (e.g.
// "СИЛЬНІ СТОРОНИ") — a heuristic instead of hardcoding exact titles, since the model doesn't
// always reproduce the parenthesised part of the prompt's headings.
function isHeading(line) {
  if (!line || line === '---' || /^[-*•]\s/.test(line)) return false;
  const letters = line.replace(/[^a-zA-Zа-яА-ЯіїєґІЇЄҐ]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase() && line.length < 90;
}

// Normalise the model's markdown so nothing leaks through as a literal artifact:
// - "**bold**" / "__bold__" -> single-asterisk "*bold*" (renderInline handles single only, so
//   double asterisks would otherwise print as stray "*" characters — the exact bug we're fixing);
// - drop leading "#"/">"/backticks that pdfkit can't interpret.
function normalizeLine(line) {
  return line
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^>\s?/, '');
}

// Renders one paragraph, switching between the regular and bold font wherever the text wraps a
// span in *asterisks* — pdfkit has no markdown support. Assumes normalizeLine has run first.
function renderInline(doc, text, { prefix = '' } = {}) {
  const parts = text.split(/(\*[^*]+\*)/g).filter(Boolean);
  if (prefix) doc.font('Regular').text(prefix, { continued: true });
  parts.forEach((part, i) => {
    const isBold = part.startsWith('*') && part.endsWith('*') && part.length > 2;
    doc.font(isBold ? 'Bold' : 'Regular');
    doc.text(isBold ? part.slice(1, -1) : part, { continued: i < parts.length - 1 });
  });
}

function drawRule(doc) {
  const y = doc.y + 2;
  doc
    .save()
    .strokeColor(COLOR_RULE)
    .lineWidth(0.75)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke()
    .restore();
  doc.y = y + 6;
  doc.fillColor(COLOR_TEXT);
}

function renderReportBody(doc, text) {
  for (const rawLine of text.split('\n')) {
    const line = normalizeLine(rawLine.trim());
    if (!line) {
      doc.moveDown(0.4);
      continue;
    }
    if (line === '---') {
      doc.moveDown(0.3);
      drawRule(doc);
      continue;
    }
    if (isHeading(line)) {
      doc.moveDown(0.5).font('Bold').fontSize(13).fillColor(COLOR_HEADING).text(line);
      doc.moveDown(0.2).fontSize(11).fillColor(COLOR_TEXT);
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      renderInline(doc, line.replace(/^[-*•]\s+/, ''), { prefix: '   •  ' });
      continue;
    }
    renderInline(doc, line);
    doc.moveDown(0.2);
  }
}

function addFooters(doc, footerText) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // Drawing inside the default bottom margin makes pdfkit think the text overflows and append
    // a blank page per footer; dropping the margin to 0 for this one call prevents that.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Regular')
      .fontSize(8)
      .fillColor(COLOR_MUTED)
      .text(`${footerText} · стор. ${i + 1} з ${range.count}`, 50, doc.page.height - 40, {
        width: doc.page.width - 100,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = bottomMargin;
  }
}

// managerReports: [{ managerName, subtitle, reportText }]. One page per manager (new manager
// always starts on a fresh page). periodLabel goes into the page footer. Returns a PDF Buffer.
function generateReportPdf(managerReports, { periodLabel }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    doc.registerFont('Regular', FONT_REGULAR);
    doc.registerFont('Bold', FONT_BOLD);

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    managerReports.forEach((mr, i) => {
      if (i > 0) doc.addPage();
      doc.font('Bold').fontSize(18).fillColor(COLOR_HEADING).text(mr.managerName);
      if (mr.subtitle) {
        doc.font('Regular').fontSize(10).fillColor(COLOR_MUTED).text(mr.subtitle);
      }
      doc.moveDown(1).fontSize(11).fillColor(COLOR_TEXT);
      renderReportBody(doc, mr.reportText);
    });

    addFooters(doc, `Аналіз дзвінків менеджерів · ${periodLabel}`);
    doc.end();
  });
}

export { generateReportPdf };
