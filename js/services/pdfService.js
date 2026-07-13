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
   * מחלץ את כל פריטי הטקסט וההערות (annotations) עם מיקומם בקואורדינטות
   * עמוד (נקודות PDF, ראשית למעלה-שמאל כמו בקנבס):
   * [{text, x, y, w?, h?, source: 'text'|'annot'|'freetext'}]
   *
   * ההערות חשובות במיוחד: ייצוא מאוטוקאד מטמיע את כל טקסט ה-SHX של
   * השרטוט (שמות חדרים, מידות, מעגלים) כהערות, וגם המשתמש יכול להוסיף
   * שמות חדרים כהערות טקסט (FreeText) בכל עורך PDF.
   */
  async extractTextItems() {
    const content = await this.page.getTextContent();
    // חשוב: טקסט התוכן חי במרחב ה-user של ה-PDF (ה-MediaBox, לפני סיבוב
    // העמוד). בעמודים מסובבים (נפוץ בייצוא אוטוקאד) גובה ה-MediaBox שונה
    // מגובה התצוגה — שימוש בגובה התצוגה מסיט את כל הנקודות אנכית.
    const [vx0, vy0, , vy1] = this.page.view; // MediaBox: [x0, y0, x1, y1]
    const userHeight = vy1 - vy0;
    const items = content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({
        text: it.str.trim(),
        // transform[4],[5] = מיקום במרחב ה-user (ראשית למטה-שמאל)
        x: it.transform[4] - vx0,
        y: userHeight - it.transform[5], // היפוך ציר Y לקואורדינטות מסך
        source: 'text',
      }));

    const annots = await this.page.getAnnotations();
    for (const a of annots) {
      const text = (a.contentsObj?.str ?? a.contents ?? '').trim();
      if (!text || !a.rect) continue;
      // rect במרחב ה-user של ה-PDF — ההמרה דרך ה-viewport מטפלת גם
      // בעמודים מסובבים, ואז מנרמלים חזרה לקואורדינטות עמוד
      const [vx0, vy0] = this.viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [vx1, vy1] = this.viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
      items.push({
        text,
        x: (vx0 + vx1) / 2 / RENDER_SCALE,
        y: (vy0 + vy1) / 2 / RENDER_SCALE,
        w: Math.abs(vx1 - vx0) / RENDER_SCALE,
        h: Math.abs(vy1 - vy0) / RENDER_SCALE,
        source: a.subtype === 'FreeText' ? 'freetext' : 'annot',
      });
    }
    return items;
  }

  /** המרה מקואורדינטות עמוד לפיקסלים של קנבס הרינדור */
  pageToCanvas(x, y) {
    return { x: x * RENDER_SCALE, y: y * RENDER_SCALE };
  }

  canvasToPage(x, y) {
    return { x: x / RENDER_SCALE, y: y / RENDER_SCALE };
  }
}
