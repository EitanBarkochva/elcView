// ===== שירות PDF — טעינה, רינדור וחילוץ טקסט =====
// עוטף את pdf.js (נטען כ-UMD ב-index.html ⇒ window.pdfjsLib)

import { RENDER_SCALE } from '../config.js';

const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export class PdfService {
  constructor() {
    this.doc = null;
    this.page = null;
    this.viewport = null; // viewport בקנה המידה של הרינדור
  }

  /** טוען PDF מ-ArrayBuffer ומחזיר את מספר העמודים */
  async load(arrayBuffer) {
    this.doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    this.page = await this.doc.getPage(1); // שרטוט = עמוד ראשון
    this.viewport = this.page.getViewport({ scale: RENDER_SCALE });
    return this.doc.numPages;
  }

  get pageSize() {
    const vp = this.page.getViewport({ scale: 1 });
    return { width: vp.width, height: vp.height };
  }

  /** מרנדר את העמוד לקנבס הנתון */
  async renderTo(canvas) {
    canvas.width = this.viewport.width;
    canvas.height = this.viewport.height;
    const ctx = canvas.getContext('2d');
    await this.page.render({ canvasContext: ctx, viewport: this.viewport }).promise;
  }

  /**
   * מחלץ את כל פריטי הטקסט עם מיקומם בקואורדינטות עמוד (נקודות PDF,
   * ראשית למעלה-שמאל כמו בקנבס): [{text, x, y}]
   */
  async extractTextItems() {
    const content = await this.page.getTextContent();
    const pageHeight = this.pageSize.height;
    return content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({
        text: it.str.trim(),
        // transform[4],[5] = מיקום בקואורדינטות PDF (ראשית למטה-שמאל)
        x: it.transform[4],
        y: pageHeight - it.transform[5], // היפוך ציר Y לקואורדינטות מסך
      }));
  }

  /** המרה מקואורדינטות עמוד לפיקסלים של קנבס הרינדור */
  pageToCanvas(x, y) {
    return { x: x * RENDER_SCALE, y: y * RENDER_SCALE };
  }

  canvasToPage(x, y) {
    return { x: x / RENDER_SCALE, y: y / RENDER_SCALE };
  }
}
