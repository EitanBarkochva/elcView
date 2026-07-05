// ===== שירות PDF — טעינה, רינדור וחילוץ טקסט =====
// עוטף את pdf.js (נטען כ-UMD ב-index.html ⇒ window.pdfjsLib)

import { RENDER_SCALE } from '../config.js';

const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';

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

  /**
   * מרנדר את העמוד לקנבס הנתון. הרינדור נעשה לקנבס פנימי חדש בכל קריאה
   * (ל-pdf.js יש נעילה פר-קנבס שנתקעת אם רינדור קודם נקטע), ורק בסיום
   * התוצאה מועתקת לקנבס התצוגה.
   */
  async renderTo(canvas) {
    if (this._renderTask) {
      try { this._renderTask.cancel(); await this._renderTask.promise; } catch { /* ביטול צפוי */ }
      this._renderTask = null;
    }
    const off = document.createElement('canvas');
    off.width = this.viewport.width;
    off.height = this.viewport.height;
    // intent:'print' — ציור בלי requestAnimationFrame, כדי שהרינדור לא
    // ייתקע כשהטאב ברקע (למשל כשעוברים לאפליקציה אחרת בטלפון)
    this._renderTask = this.page.render({
      canvasContext: off.getContext('2d'),
      viewport: this.viewport,
      intent: 'print',
    });
    try {
      await this._renderTask.promise;
    } finally {
      this._renderTask = null;
    }
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
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
