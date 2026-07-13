// ===== זיהוי גיאומטרי של סמלי CAD בשרטוט =====
//
// עיבוד תמונה על קנבס הרינדור: בינריזציה ⇒ רכיבים קשירים ⇒ סינון לפי
// גודל וצורה. סמל שקע הוא טבעת-עיגול קטנה (עם נקודות בפנים); סמלים
// משולשים מזוהים לפי פרופיל רדיאלי עם 3 שיאים. התוצאה: קואורדינטות כל
// סמל בשרטוט, שמתחברות אחר-כך לתוויות הטקסט לפי קרבה פיזית (detector.js).

import { RENDER_SCALE } from '../config.js';

// גבולות גודל סמל בפיקסלים של קנבס הרינדור (scale 2 ⇒ ‎4–22 נקודות עמוד)
const MIN_DIAMETER = 7;
const MAX_DIAMETER = 44;
const DARK_THRESHOLD = 110;   // בהירות שמתחתיה פיקסל נחשב קו
const SECTORS = 24;           // רזולוציית הפרופיל הזוויתי
const LINE_RUN = 46;          // רצף ארוך מזה (בפיקסלים) נחשב קיר/קו מידה ונמחק

export class SymbolDetector {
  /**
   * @param {HTMLCanvasElement} canvas קנבס השרטוט המרונדר
   * @param {Array<{text,x,y,w?,h?}>} textItems תוויות ידועות — האזורים
   *        שלהן נמחקים מהמסכה (אותיות עבריות נראות כעיגולים ומייצרות רעש)
   * @returns {Array<{x, y, r, shape}>} סמלים בקואורדינטות עמוד;
   *          shape: 'circle' | 'triangle'
   */
  detect(canvas, textItems = []) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const W = canvas.width;
    const H = canvas.height;
    const data = ctx.getImageData(0, 0, W, H).data;

    // 1. מסכת קווים (פיקסלים כהים)
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      if (lum < DARK_THRESHOLD) mask[i] = 1;
    }

    // 1ב. מחיקת אזורי טקסט ידועים — אותיות כמו מ/ם/ס נראות כעיגולים
    for (const t of textItems) {
      const x0 = Math.max(0, Math.round((t.x - 3) * RENDER_SCALE));
      const y0 = Math.max(0, Math.round((t.y - 9) * RENDER_SCALE));
      const wPt = t.w || Math.max(10, (t.text?.length || 2) * 5.5);
      const hPt = t.h || 12;
      const x1 = Math.min(W, Math.round((t.x + wPt + 3) * RENDER_SCALE));
      const y1 = Math.min(H, Math.round((t.y + hPt - 4) * RENDER_SCALE));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) mask[y * W + x] = 0;
      }
    }

    // 1ג. מחיקת קווים ארוכים (קירות, קווי מידה) — סמלי השקעים נוגעים
    // בקירות, ובלי המחיקה הם "נדבקים" לרכיב הקיר הענק ונעלמים.
    this.#removeLongRuns(mask, W, H);

    // 2. תיוג רכיבים קשירים (שני מעברים, union-find)
    const labels = new Int32Array(W * H);
    const parent = [0];
    const find = (a) => {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    };
    let next = 1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        const left = x > 0 ? labels[i - 1] : 0;
        const up = y > 0 ? labels[i - W] : 0;
        if (!left && !up) {
          labels[i] = next;
          parent[next] = next;
          next++;
        } else if (left && up) {
          const rl = find(left);
          const ru = find(up);
          labels[i] = rl;
          if (rl !== ru) parent[ru] = rl;
        } else {
          labels[i] = left || up;
        }
      }
    }

    // 3. סטטיסטיקות לכל רכיב: שטח, מרכז, תיבה תוחמת
    const stats = new Map();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const l = labels[y * W + x];
        if (!l) continue;
        const root = find(l);
        let s = stats.get(root);
        if (!s) {
          s = { n: 0, sx: 0, sy: 0, minX: x, maxX: x, minY: y, maxY: y };
          stats.set(root, s);
        }
        s.n++;
        s.sx += x;
        s.sy += y;
        if (x < s.minX) s.minX = x;
        if (x > s.maxX) s.maxX = x;
        if (y < s.minY) s.minY = y;
        if (y > s.maxY) s.maxY = y;
      }
    }

    // 4. סינון ראשוני לפי גודל ויחס צלעות — מועמדים לסמלים
    const candidates = new Map();
    for (const [root, s] of stats) {
      const w = s.maxX - s.minX + 1;
      const h = s.maxY - s.minY + 1;
      const d = Math.max(w, h);
      if (d < MIN_DIAMETER || d > MAX_DIAMETER) continue;
      const aspect = w / h;
      if (aspect < 0.6 || aspect > 1.7) continue;
      candidates.set(root, {
        ...s,
        cx: s.sx / s.n,
        cy: s.sy / s.n,
        w, h,
        radial: new Float64Array(SECTORS), // רדיוס מקסימלי לכל גזרה
        sumR: 0,
        sumR2: 0,
        sectorHit: new Uint8Array(SECTORS),
      });
    }

    // 5. מעבר שלישי: פרופיל רדיאלי לכל מועמד
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const l = labels[y * W + x];
        if (!l) continue;
        const c = candidates.get(find(l));
        if (!c) continue;
        const dx = x - c.cx;
        const dy = y - c.cy;
        const r = Math.hypot(dx, dy);
        c.sumR += r;
        c.sumR2 += r * r;
        const sector = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * SECTORS) % SECTORS;
        c.sectorHit[sector] = 1;
        if (r > c.radial[sector]) c.radial[sector] = r;
      }
    }

    // 6. סיווג צורה לפי הפרופיל
    const symbols = [];
    for (const c of candidates.values()) {
      const meanR = c.sumR / c.n;
      if (meanR < 2) continue;
      const stdR = Math.sqrt(Math.max(0, c.sumR2 / c.n - meanR * meanR));
      const rel = stdR / meanR;

      // כיסוי זוויתי — סמל סגור מכסה כמעט את כל הגזרות
      let covered = 0;
      for (let s = 0; s < SECTORS; s++) covered += c.sectorHit[s];
      if (covered < SECTORS * 0.8) continue;

      const shape = this.#classify(c, rel);
      if (!shape) continue;

      symbols.push({
        x: c.cx / RENDER_SCALE,
        y: c.cy / RENDER_SCALE,
        r: (Math.max(c.w, c.h) / 2) / RENDER_SCALE,
        shape,
      });
    }
    return symbols;
  }

  /** מוחק רצפים אופקיים ואנכיים ארוכים של פיקסלים כהים */
  #removeLongRuns(mask, W, H) {
    // אופקי
    for (let y = 0; y < H; y++) {
      let start = -1;
      for (let x = 0; x <= W; x++) {
        const on = x < W && mask[y * W + x];
        if (on && start < 0) start = x;
        else if (!on && start >= 0) {
          if (x - start >= LINE_RUN) {
            for (let k = start; k < x; k++) mask[y * W + k] = 0;
          }
          start = -1;
        }
      }
    }
    // אנכי
    for (let x = 0; x < W; x++) {
      let start = -1;
      for (let y = 0; y <= H; y++) {
        const on = y < H && mask[y * W + x];
        if (on && start < 0) start = y;
        else if (!on && start >= 0) {
          if (y - start >= LINE_RUN) {
            for (let k = start; k < y; k++) mask[k * W + x] = 0;
          }
          start = -1;
        }
      }
    }
  }

  /**
   * טבעת עיגול: פיזור רדיאלי קטן (הקו כולו במרחק ~R מהמרכז) ופרופיל שטוח.
   * משולש: פרופיל עם 3 שיאים בפערים של ~120 מעלות.
   */
  #classify(c, rel) {
    const maxR = Math.max(...c.radial);
    if (maxR <= 0) return null;

    // כמה גזרות קרובות לרדיוס המקסימלי — בעיגול כמעט כולן, במשולש רק הפינות
    let nearMax = 0;
    for (let s = 0; s < SECTORS; s++) {
      if (c.radial[s] > 0.82 * maxR) nearMax++;
    }

    if (rel < 0.28 && nearMax >= SECTORS * 0.7) return 'circle';

    if (rel >= 0.2 && rel < 0.55 && nearMax >= 2 && nearMax <= SECTORS * 0.45) {
      // ספירת קבוצות שיאים רצופות (מעגלית)
      let groups = 0;
      for (let s = 0; s < SECTORS; s++) {
        const cur = c.radial[s] > 0.82 * maxR;
        const prev = c.radial[(s + SECTORS - 1) % SECTORS] > 0.82 * maxR;
        if (cur && !prev) groups++;
      }
      if (groups === 3) return 'triangle';
    }
    return null;
  }
}
