// ===== ראייה ממוחשבת — זיהוי קופסאות חשמל כתומות בפריים מצלמה =====
//
// קופסאות ההשחלה בקירות בישראל ("קופסת 55") כתומות ובגודל תקני של 55 מ"מ.
// הזיהוי: סינון צבע ב-HSV ⇒ מסכה בינארית ⇒ תיוג רכיבים קשירים ⇒
// סינון לפי גודל, יחס צלעות ומילוי.

import { VISION } from '../config.js';

export class OrangeBoxDetector {
  /**
   * @param {ImageData} imageData פריים (רצוי מוקטן לרוחב VISION.DETECT_WIDTH)
   * @returns {Array<{x,y,w,h,cx,cy,area}>} תיבות בקואורדינטות הפריים
   */
  detect(imageData) {
    const { width: W, height: H, data } = imageData;
    const mask = this.#orangeMask(data, W, H);
    const boxes = this.#connectedComponents(mask, W, H);
    return boxes.filter((b) => {
      const aspect = b.w / b.h;
      const fill = b.area / (b.w * b.h);
      return b.area >= VISION.MIN_AREA_PX &&
        aspect > 0.35 && aspect < 2.8 &&
        fill > 0.35;
    }).sort((a, b) => b.area - a.area);
  }

  /** מסכה בינארית של פיקסלים כתומים */
  #orangeMask(data, W, H) {
    const { hMin, hMax, sMin, vMin } = VISION.ORANGE;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4] / 255;
      const g = data[i * 4 + 1] / 255;
      const b = data[i * 4 + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const v = max;
      const s = max === 0 ? 0 : (max - min) / max;
      if (s < sMin || v < vMin) continue;
      // גוון (hue) במעלות 0-360 — כתום יושב סביב 10-45
      let h;
      const d = max - min;
      if (d === 0) continue;
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
      if (h >= hMin && h <= hMax) mask[i] = 1;
    }
    return mask;
  }

  /** תיוג רכיבים קשירים בשני מעברים (union-find) ⇒ תיבות תוחמות */
  #connectedComponents(mask, W, H) {
    const labels = new Int32Array(W * H);
    const parent = [0]; // parent[label] — עצי איחוד
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

    // איסוף תיבות לפי שורש
    const acc = new Map();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const l = labels[y * W + x];
        if (!l) continue;
        const root = find(l);
        let b = acc.get(root);
        if (!b) {
          b = { minX: x, maxX: x, minY: y, maxY: y, area: 0 };
          acc.set(root, b);
        }
        if (x < b.minX) b.minX = x;
        if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y;
        if (y > b.maxY) b.maxY = y;
        b.area++;
      }
    }

    return [...acc.values()].map((b) => ({
      x: b.minX,
      y: b.minY,
      w: b.maxX - b.minX + 1,
      h: b.maxY - b.minY + 1,
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
      area: b.area,
    }));
  }
}
