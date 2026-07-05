// ===== מנוע המדידה — מפיקסלים לסנטימטרים =====
//
// קנה המידה נגזר מהגודל התקני של קופסת ההשחלה (55 מ"מ): ידיעת גודלה
// בפיקסלים נותנת מ"מ-לפיקסל במישור הקיר. גובה מהרצפה = המרחק האנכי
// ממרכז הקופסה לקו הרצפה; מרחק מפינה = המרחק האופקי לקצה הקיר.
// את קו הרצפה והפינה מזהים לפי קפיצת הבהירות החזקה ביותר (פנלים/פינה),
// ובמצב ידני המשתמש מקיש על הנקודות בעצמו.

import { VISION } from '../config.js';

export class MeasurementEngine {
  /** מ"מ לפיקסל לפי גודל הקופסה בפריים */
  mmPerPixel(box) {
    const sizePx = (box.w + box.h) / 2;
    return VISION.BOX_SIZE_MM / sizePx;
  }

  /**
   * מדידה אוטומטית: מאתר קו רצפה מתחת לקופסה ופינת קיר לצידה.
   * @param {ImageData} imageData פריים ברזולוציה מלאה
   * @param {object} box תיבת הקופסה באותן קואורדינטות
   * @returns {{heightCm, cornerCm, floorY, cornerX, mmpp}} ערכים חסרים = null
   */
  measureAuto(imageData, box) {
    const gray = this.#toGray(imageData);
    const { width: W, height: H } = imageData;
    const mmpp = this.mmPerPixel(box);

    const floorY = this.#findFloorY(gray, W, H, box);
    const cornerX = this.#findCornerX(gray, W, H, box);

    return {
      mmpp,
      floorY,
      cornerX,
      heightCm: floorY != null ? this.#toCm((floorY - box.cy) * mmpp) : null,
      cornerCm: cornerX != null ? this.#toCm(Math.abs(cornerX - box.cx) * mmpp) : null,
    };
  }

  /** מדידה לפי נקודות שהמשתמש הקיש: רצפה ו/או פינה */
  measureFromPoints(box, mmpp, floorPoint, cornerPoint) {
    return {
      heightCm: floorPoint ? this.#toCm((floorPoint.y - box.cy) * mmpp) : null,
      cornerCm: cornerPoint ? this.#toCm(Math.abs(cornerPoint.x - box.cx) * mmpp) : null,
      floorY: floorPoint?.y ?? null,
      cornerX: cornerPoint?.x ?? null,
      mmpp,
    };
  }

  #toCm(mm) {
    return Math.max(0, Math.round(mm / 10));
  }

  #toGray(imageData) {
    const { width: W, height: H, data } = imageData;
    const gray = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return gray;
  }

  /**
   * קו הרצפה: סורק שורות מתחת לקופסה ברצועה ברוחב הקופסה,
   * ומחפש את קפיצת הבהירות האנכית החזקה ביותר.
   */
  #findFloorY(gray, W, H, box) {
    const x0 = Math.max(0, Math.round(box.cx - box.w));
    const x1 = Math.min(W - 1, Math.round(box.cx + box.w));
    const yStart = Math.min(H - 2, Math.round(box.y + box.h * 1.5));
    return this.#strongestEdge(
      (y) => this.#rowMean(gray, W, x0, x1, y),
      yStart, H - 2,
    );
  }

  /**
   * פינת הקיר: סורק עמודות משני צידי הקופסה ברצועה סביב גובה הקופסה,
   * ובוחר את הקפיצה החזקה מבין שני הכיוונים.
   */
  #findCornerX(gray, W, H, box) {
    const y0 = Math.max(0, Math.round(box.cy - box.h));
    const y1 = Math.min(H - 1, Math.round(box.cy + box.h));
    const colMean = (x) => this.#colMean(gray, W, y0, y1, x);

    const margin = Math.round(box.w * 1.5);
    const right = this.#strongestEdge(colMean, Math.min(W - 2, Math.round(box.cx) + margin), W - 2);
    const left = this.#strongestEdge(colMean, Math.max(1, Math.round(box.cx) - margin), 1);

    if (right == null && left == null) return null;
    if (right == null) return left;
    if (left == null) return right;
    // שניהם נמצאו — הקרוב יותר לקופסה הוא כנראה הפינה הרלוונטית
    return Math.abs(right - box.cx) < Math.abs(left - box.cx) ? right : left;
  }

  /**
   * סריקה חד-ממדית מ-from עד to (בכל כיוון): מחזיר את המיקום שבו
   * הפרש הממוצעים בין חלונות סמוכים מקסימלי ומעל הסף, או null.
   */
  #strongestEdge(meanAt, from, to) {
    const step = from <= to ? 1 : -1;
    const win = 3; // חלון החלקה
    let bestPos = null;
    let bestDiff = VISION.EDGE_THRESHOLD;
    for (let p = from + win * step; step > 0 ? p <= to - win : p >= to + win; p += step) {
      let before = 0;
      let after = 0;
      for (let k = 1; k <= win; k++) {
        before += meanAt(p - k * step);
        after += meanAt(p + k * step);
      }
      const diff = Math.abs(after - before) / win;
      if (diff > bestDiff) {
        bestDiff = diff;
        bestPos = p;
      }
    }
    return bestPos;
  }

  #rowMean(gray, W, x0, x1, y) {
    let sum = 0;
    for (let x = x0; x <= x1; x++) sum += gray[y * W + x];
    return sum / (x1 - x0 + 1);
  }

  #colMean(gray, W, y0, y1, x) {
    let sum = 0;
    for (let y = y0; y <= y1; y++) sum += gray[y * W + x];
    return sum / (y1 - y0 + 1);
  }
}
