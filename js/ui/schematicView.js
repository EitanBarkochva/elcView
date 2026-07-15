// ===== שרטוט חשמלי נקי =====
// תמונת הבית עם אביזרי החשמל בלבד: מחלצים מהרינדור את הקירות (קווים
// ארוכים ועבים), מעלימים את כל השאר (ריהוט, מידות, טקסטים), ומציירים
// מעל כל אביזר סמל צבעוני עם המזהה שלו (מטבח-1...). מתחת — מקרא שנבנה
// אוטומטית מהאביזרים שבתוכנית.

import { RENDER_SCALE } from '../config.js';

const DARK_THRESHOLD = 210; // כולל גם קירות במילוי אפור בהיר
const WALL_MIN_LENGTH = 40; // רצף מינימלי (בפיקסלים) כדי להיחשב קו קיר
const WALL_MIN_THICK = 8;   // עובי מינימלי (אחרי איחוי) — מסנן קווי מידה וטקסט
const MIN_WALL_COVERAGE = 0.003; // מתחת לזה עוברים לכל הקווים הארוכים

// צבע לכל סוג אביזר
const KIND_COLORS = {
  'שקע': '#1565c0',
  'TV': '#6a1b9a',
  'תקשורת': '#00838f',
  'אחר': '#546e7a',
};
const PRODUCT_COLOR = '#e65100'; // מוצרי חשמל מהמקרא (דוד, מזגן...)

export class SchematicView {
  /**
   * בונה את תמונת השרטוט החשמלי המלאה (בית + אביזרים + מקרא).
   * @param {HTMLCanvasElement} planCanvas רינדור השרטוט המקורי
   * @param {Room[]} rooms
   * @param {Outlet[]} outlets
   * @returns {HTMLCanvasElement} קנבס מוכן לתצוגה/הורדה
   */
  build(planCanvas, rooms, outlets, textItems = []) {
    const W = planCanvas.width;
    const H = planCanvas.height;

    // האביזרים שבתחומי הדף בלבד
    const items = outlets.filter((o) => {
      const x = o.x * RENDER_SCALE;
      const y = o.y * RENDER_SCALE;
      return x >= 0 && x <= W && y >= 0 && y <= H;
    });
    const kinds = this.#collectKinds(items);

    // קנבס פלט: השרטוט + רצועת מקרא מתחת
    const legendRowH = 44;
    const legendH = 70 + Math.ceil(kinds.length / 3) * legendRowH;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H + legendH;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);

    this.#drawWalls(ctx, planCanvas, textItems);
    this.#drawRoomNames(ctx, rooms);
    this.#drawFixtures(ctx, items);
    this.#drawTitle(ctx, W);
    this.#drawLegend(ctx, kinds, 0, H, W, legendH);
    return out;
  }

  /** חילוץ הקירות: פיקסלים כהים שהם גם חלק מקו ארוך וגם עבים */
  #drawWalls(ctx, planCanvas, textItems) {
    const W = planCanvas.width;
    const H = planCanvas.height;
    const src = planCanvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, W, H).data;

    let dark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const lum = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
      if (lum < DARK_THRESHOLD) dark[i] = 1;
    }

    // מחיקת אזורי הטקסט הידועים — אחרת אחרי האיחוי הם ייראו כקווים
    for (const t of textItems) {
      const wPt = t.w || Math.max(10, (t.text?.length || 2) * 5.5);
      const hPt = t.h || 12;
      const x0 = Math.max(0, Math.round((t.x - 3) * RENDER_SCALE));
      const y0 = Math.max(0, Math.round((t.y - 10) * RENDER_SCALE));
      const x1 = Math.min(W, Math.round((t.x + wPt + 3) * RENDER_SCALE));
      const y1 = Math.min(H, Math.round((t.y + hPt - 3) * RENDER_SCALE));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) dark[y * W + x] = 0;
      }
    }

    // איחוי מילוי מקווקו של קירות: הרווחים הלבנים שבין קווי ה-hatch
    // שוברים את הרצפים — הרחבה קלה מאחה אותם לגוש מלא
    dark = this.#dilate(dark, W, H, 2);

    // קווים ארוכים אופקית/אנכית
    const longH = this.#longRuns(dark, W, H, true, WALL_MIN_LENGTH);
    const longV = this.#longRuns(dark, W, H, false, WALL_MIN_LENGTH);

    // עובי: קו אופקי ארוך שעבה אנכית (ולהפך) = קיר
    const thickH = this.#longRuns(longH, W, H, false, WALL_MIN_THICK);
    const thickV = this.#longRuns(longV, W, H, true, WALL_MIN_THICK);

    // אם הקירות בשרטוט הזה דקים (double-line) — מחזיקים את כל הקווים הארוכים
    let count = 0;
    for (let i = 0; i < W * H; i++) if (thickH[i] || thickV[i]) count++;
    const useThin = count < W * H * MIN_WALL_COVERAGE;

    let wall = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      wall[i] = useThin ? (longH[i] || longV[i]) : (thickH[i] || thickV[i]);
    }
    // עיבוי הקירות כדי שיהיו ברורים גם בתצוגה מוקטנת (הרחבה נפרדת לצירים)
    wall = this.#dilate(wall, W, H, 2);

    const img = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      img.data[j] = wall[i] ? 60 : 255;
      img.data[j + 1] = wall[i] ? 66 : 255;
      img.data[j + 2] = wall[i] ? 72 : 255;
      img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  /** הרחבת מסכה ברדיוס נתון (שני מעברים חד-ממדיים) */
  #dilate(mask, W, H, radius) {
    const tmp = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        for (let k = -radius; k <= radius; k++) {
          const nx = x + k;
          if (nx >= 0 && nx < W) tmp[y * W + nx] = 1;
        }
      }
    }
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!tmp[y * W + x]) continue;
        for (let k = -radius; k <= radius; k++) {
          const ny = y + k;
          if (ny >= 0 && ny < H) out[ny * W + x] = 1;
        }
      }
    }
    return out;
  }

  /** מסכת רצפים באורך מינימלי, לאורך שורות (horizontal=true) או עמודות */
  #longRuns(mask, W, H, horizontal, minLen) {
    const out = new Uint8Array(W * H);
    const outer = horizontal ? H : W;
    const inner = horizontal ? W : H;
    for (let a = 0; a < outer; a++) {
      let start = -1;
      for (let b = 0; b <= inner; b++) {
        const idx = horizontal ? a * W + b : b * W + a;
        const on = b < inner && mask[idx];
        if (on && start < 0) start = b;
        else if (!on && start >= 0) {
          if (b - start >= minLen) {
            for (let k = start; k < b; k++) {
              out[horizontal ? a * W + k : k * W + a] = 1;
            }
          }
          start = -1;
        }
      }
    }
    return out;
  }

  #drawRoomNames(ctx, rooms) {
    const size = Math.max(26, Math.round(ctx.canvas.width / 75));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(90, 105, 120, 0.55)';
    ctx.font = `bold ${size}px Arial`;
    for (const room of rooms) {
      if (!room.bounds) continue;
      const cx = (room.bounds.x + room.bounds.w / 2) * RENDER_SCALE;
      const cy = (room.bounds.y + room.bounds.h / 2) * RENDER_SCALE;
      ctx.fillText(room.name, cx, cy);
    }
    ctx.restore();
  }

  #drawFixtures(ctx, outlets) {
    const W = ctx.canvas.width;
    const r = Math.max(11, Math.round(W / 190));       // רדיוס הסמל
    const fontSize = Math.max(20, Math.round(W / 105)); // גודל המזהה
    ctx.save();
    for (const o of outlets) {
      const x = o.x * RENDER_SCALE;
      const y = o.y * RENDER_SCALE;
      const color = KIND_COLORS[o.kind] || PRODUCT_COLOR;

      // סמל: עיגול מלא עם טבעת לבנה
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = Math.max(3, r / 4);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      if (o.quantity > 1) {
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(r * 1.2)}px Arial`;
        ctx.textAlign = 'center';
        ctx.fillText(String(o.quantity), x, y + r * 0.42);
      }

      // המזהה (מטבח-1) עם הילה לבנה לקריאות
      const label = o.label || o.kind;
      ctx.font = `bold ${fontSize}px Arial`;
      ctx.textAlign = 'center';
      ctx.lineWidth = Math.max(5, fontSize / 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(label, x, y - r - 7);
      ctx.fillStyle = color;
      ctx.fillText(label, x, y - r - 7);
    }
    ctx.restore();
  }

  #drawTitle(ctx, W) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#1c2733';
    ctx.font = 'bold 34px Arial';
    ctx.fillText('שרטוט חשמלי', W / 2, 44);
    ctx.restore();
  }

  /** אילו סוגי אביזרים קיימים בתוכנית + כמה מכל אחד */
  #collectKinds(outlets) {
    const counts = new Map();
    for (const o of outlets) {
      counts.set(o.kind, (counts.get(o.kind) || 0) + (o.quantity || 1));
    }
    return [...counts.entries()].map(([kind, count]) => ({
      kind,
      count,
      color: KIND_COLORS[kind] || PRODUCT_COLOR,
    }));
  }

  /** רצועת המקרא בתחתית התמונה */
  #drawLegend(ctx, kinds, x0, y0, width, height) {
    ctx.save();
    // מסגרת וכותרת
    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(x0, y0, width, height);
    ctx.strokeStyle = '#90a0b0';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 10, y0 + 10, width - 20, height - 20);
    ctx.fillStyle = '#1c2733';
    ctx.font = 'bold 26px Arial';
    ctx.textAlign = 'right';
    ctx.fillText('מקרא', x0 + width - 30, y0 + 46);

    // פריטי המקרא בשלוש עמודות, מימין לשמאל
    ctx.font = '22px Arial';
    const cols = 3;
    const colW = (width - 60) / cols;
    kinds.forEach((k, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = x0 + width - 30 - col * colW; // עמודה ימנית ראשונה
      const cy = y0 + 78 + row * 44;
      ctx.beginPath();
      ctx.arc(cx - 12, cy - 7, 10, 0, Math.PI * 2);
      ctx.fillStyle = k.color;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#1c2733';
      ctx.textAlign = 'right';
      ctx.fillText(`${k.kind} × ${k.count}`, cx - 32, cy);
    });
    ctx.restore();
  }
}
