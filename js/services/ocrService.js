// ===== שירות OCR — זיהוי שמות חדרים מתמונת השרטוט =====
// שמות החדרים בשרטוטי אוטוקאד מצוירים כקווים ולא כטקסט, לכן מריצים
// Tesseract (עברית) על הקנבס המרונדר. התוצאות הן הצעות בלבד.

import { RENDER_SCALE } from '../config.js';

export class OcrService {
  /**
   * מריץ OCR על קנבס ומחזיר מילים בקואורדינטות עמוד PDF:
   * [{text, x, y, w, h, confidence}]
   * @param {HTMLCanvasElement} canvas
   * @param {(progress:number)=>void} onProgress 0..1
   */
  async recognizeRoomNames(canvas, onProgress = () => {}) {
    const worker = await window.Tesseract.createWorker('heb', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress(m.progress);
      },
    });
    try {
      // מצב "טקסט פזור" — מתאים לתוויות בודדות בשרטוט (לא פסקאות)
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const { data } = await worker.recognize(canvas);
      const words = [];
      for (const w of data.words || []) {
        const text = (w.text || '').trim();
        if (!text || w.confidence < 30) continue;
        // המרה מפיקסלים של הקנבס לקואורדינטות עמוד
        words.push({
          text,
          x: w.bbox.x0 / RENDER_SCALE,
          y: w.bbox.y0 / RENDER_SCALE,
          w: (w.bbox.x1 - w.bbox.x0) / RENDER_SCALE,
          h: (w.bbox.y1 - w.bbox.y0) / RENDER_SCALE,
          confidence: w.confidence,
        });
      }
      return words;
    } finally {
      await worker.terminate();
    }
  }
}
