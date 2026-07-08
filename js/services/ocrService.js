// ===== שירות OCR — זיהוי שמות חדרים ומספרי מידות מתמונת השרטוט =====
// שמות החדרים ומספרי קווי המידה בשרטוטי אוטוקאד מצוירים כקווים ולא
// כטקסט, לכן מריצים Tesseract על הקנבס המרונדר. התוצאות הן הצעות בלבד.

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

  /**
   * מזהה מספרי מידות (קווי המידה שלצד הקירות): OCR ספרות-בלבד.
   * מחזיר [{value, x, y, w, h, confidence}] בקואורדינטות עמוד,
   * כאשר x,y הם מרכז המספר.
   * @param {HTMLCanvasElement} canvas
   * @param {(progress:number)=>void} onProgress 0..1
   */
  async recognizeNumbers(canvas, onProgress = () => {}) {
    const worker = await window.Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress(m.progress);
      },
    });
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: '11',            // טקסט פזור
        tessedit_char_whitelist: '0123456789',  // ספרות בלבד
      });
      const { data } = await worker.recognize(canvas);
      const numbers = [];
      for (const w of data.words || []) {
        const text = (w.text || '').trim();
        if (!/^\d{2,3}$/.test(text) || w.confidence < 40) continue;
        const value = parseInt(text, 10);
        // טווח מרחקים סביר בס"מ
        if (value < 10 || value > 400) continue;
        numbers.push({
          value,
          x: (w.bbox.x0 + w.bbox.x1) / 2 / RENDER_SCALE,
          y: (w.bbox.y0 + w.bbox.y1) / 2 / RENDER_SCALE,
          w: (w.bbox.x1 - w.bbox.x0) / RENDER_SCALE,
          h: (w.bbox.y1 - w.bbox.y0) / RENDER_SCALE,
          confidence: w.confidence,
        });
      }
      return numbers;
    } finally {
      await worker.terminate();
    }
  }
}
