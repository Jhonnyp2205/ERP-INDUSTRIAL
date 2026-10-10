import JsBarcode from 'jsbarcode';

export interface Label { code: string; title: string; subtitle?: string; extra?: string }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Abre una ventana de impresión con etiquetas Code128 (50 × 30 mm por defecto). */
export function printLabels(labels: Label[], size = { w: 50, h: 30 }) {
  const svgs = labels.map((l) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try {
      JsBarcode(svg, l.code, { format: 'CODE128', displayValue: true, fontSize: 12, height: 40, margin: 0, width: 1.4 });
    } catch {
      return `<div class="err">Código no válido: ${esc(l.code)}</div>`;
    }
    return svg.outerHTML;
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Etiquetas</title><style>
    @page { size: ${size.w}mm ${size.h}mm; margin: 0; }
    body { margin: 0; font-family: Arial, sans-serif; }
    .l { width: ${size.w}mm; height: ${size.h}mm; box-sizing: border-box; padding: 1.5mm 2mm; page-break-after: always;
         display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; }
    .t { font-size: 9pt; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .s { font-size: 7pt; color: #333; }
    svg { max-width: 100%; height: auto; max-height: 16mm; }
  </style></head><body>
  ${labels.map((l, i) => `<div class="l"><div class="t">${esc(l.title)}</div>${l.subtitle ? `<div class="s">${esc(l.subtitle)}</div>` : ''}${svgs[i]}${l.extra ? `<div class="s">${esc(l.extra)}</div>` : ''}</div>`).join('')}
  <script>window.onload = () => { window.print(); }</script></body></html>`;
  const w = window.open('', '_blank', 'width=480,height=640');
  if (!w) { alert('Permita las ventanas emergentes para imprimir etiquetas.'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
