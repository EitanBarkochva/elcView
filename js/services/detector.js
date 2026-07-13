// ===== מנוע הזיהוי — הפיכת טקסט השרטוט לרשימת שקעים =====
//
// שכבת הטקסט של שרטוטי חשמל (ייצוא אוטוקאד) מכילה תוויות אמינות:
//   H=45 / H=120 ...  ⇒ נקודת חשמל עם גובה מהרצפה בס"מ
//   TV / T            ⇒ סוג הנקודה (טלוויזיה / תקשורת-טלפון)
// שמות חדרים ומספרי מידות מצוירים לרוב כקווים (פונט SHX) — בהם מטפל ה-OCR.

import { Outlet, Room } from '../models.js';
import { ROOM_LEXICON, PRODUCT_LEXICON, LABEL_SEPARATOR } from '../config.js';

const HEIGHT_RE = /^H\s*=\s*(\d{1,3})$/i;
const KIND_LABELS = { TV: 'TV', T: 'תקשורת', 'ת': 'תקשורת' };
const CIRCUIT_RE = /^\d{1,2}\/\d{1,2}$/;
// מרחק מקסימלי (בנקודות PDF) לשיוך תווית סוג לנקודת גובה
const KIND_ATTACH_RADIUS = 25;
// מרחק לשיוך מספרי מעגלים לנקודה (הם צמודים לסמל)
const CIRCUIT_ATTACH_RADIUS = 18;

// טקסט SHX של אוטוקאד מוטמע בהערות ה-PDF כשהעברית ממופה למקלדת
// לטינית (n=מ, y=ט, c=ב, j=ח ⇒ 'nycj' = מטבח). המפה המלאה:
const EN2HE = {
  q: '/', w: "'", e: 'ק', r: 'ר', t: 'א', y: 'ט', u: 'ו', i: 'ן', o: 'ם', p: 'פ',
  a: 'ש', s: 'ד', d: 'ג', f: 'כ', g: 'ע', h: 'י', j: 'ח', k: 'ל', l: 'ך',
  z: 'ז', x: 'ס', c: 'ב', v: 'ה', b: 'נ', n: 'מ', m: 'צ',
  ',': 'ת', '.': 'ץ', ';': 'ף', "'": ',', '/': '.',
};

/** מפענח טקסט SHX ממופה-מקלדת לעברית (או מחזיר את המקור אם אין מה לפענח) */
export function decodeShxHebrew(text) {
  let out = '';
  for (const ch of text) {
    out += EN2HE[ch.toLowerCase()] ?? ch;
  }
  return out;
}

export class PlanDetector {
  /**
   * @param {Array<{text,x,y}>} textItems פריטי טקסט מ-PdfService
   * @param {string} projectId
   * @returns {Outlet[]}
   */
  detectOutlets(textItems, projectId) {
    const items = this.#dedupeItems(textItems);
    const heightLabels = [];
    const kindLabels = [];
    const circuitLabels = [];

    for (const item of items) {
      const m = item.text.match(HEIGHT_RE);
      if (m) {
        heightLabels.push({ ...item, height: parseInt(m[1], 10) });
      } else if (KIND_LABELS[item.text.toUpperCase()]) {
        kindLabels.push({ ...item, kind: KIND_LABELS[item.text.toUpperCase()] });
      } else if (CIRCUIT_RE.test(item.text)) {
        circuitLabels.push(item);
      }
    }

    // תווית גובה יכולה להופיע גם בשכבת הטקסט וגם בהערות — איחוד כפילויות
    const uniqueHeights = [];
    for (const h of heightLabels) {
      const dup = uniqueHeights.find(
        (u) => u.height === h.height && Math.hypot(u.x - h.x, u.y - h.y) < 12,
      );
      if (!dup) uniqueHeights.push(h);
    }

    const outlets = uniqueHeights.map((h) => {
      const nearKind = this.#nearest(kindLabels, h.x, h.y, KIND_ATTACH_RADIUS);
      const outlet = new Outlet({
        project_id: projectId,
        kind: nearKind ? nearKind.kind : 'שקע',
        height_cm: h.height,
        x: h.x,
        y: h.y,
      });
      this.#attachCircuits(outlet, circuitLabels);
      return outlet;
    });

    // תוויות TV/T/ת שלא נקשרו לגובה — נקודה עצמאית ללא גובה ידוע
    for (const k of kindLabels) {
      const attached = outlets.some(
        (o) => Math.hypot(o.x - k.x, o.y - k.y) <= KIND_ATTACH_RADIUS,
      );
      if (!attached) {
        const outlet = new Outlet({
          project_id: projectId, kind: k.kind, x: k.x, y: k.y,
        });
        this.#attachCircuits(outlet, circuitLabels);
        outlets.push(outlet);
      }
    }

    // מוצרי חשמל מהמקרא (דוד, מזגן, מקרר...) — תוויות בשרטוט שנמצאות
    // במילון המוצרים הופכות לנקודה עם שם המוצר כסוג
    for (const item of items) {
      if (item.source === 'text') continue; // שמות מוצרים חיים בהערות
      const decoded = decodeShxHebrew(item.text).trim();
      if (decoded.length > 16) continue;
      const product = PRODUCT_LEXICON.find((p) => decoded.includes(p));
      if (!product) continue;
      const dup = outlets.some(
        (o) => o.kind === product && Math.hypot(o.x - item.x, o.y - item.y) < 15,
      );
      if (dup) continue;
      outlets.push(new Outlet({
        project_id: projectId, kind: product, x: item.x, y: item.y,
      }));
    }
    return outlets;
  }

  /**
   * מזהה לכל מוצר: שם החלל + מפריד + מספר רץ בסדר עולה מהפתח של
   * החלל ועד סופו. הסדר נקבע לפי הליכה על היקף מלבן החדר בכיוון
   * השעון, החל מנקודת הפתח (room.entrance) — או מהפינה השמאלית-עליונה
   * אם לא סומן פתח. נקודות בלי חדר לא מקבלות מזהה.
   */
  numberOutlets(outlets, rooms) {
    for (const room of rooms) {
      const roomOutlets = outlets.filter((o) => o.roomId === room.id);
      if (!roomOutlets.length || !room.bounds) continue;

      const start = room.entrance
        ? this.#perimeterPos(room.bounds, room.entrance.x, room.entrance.y)
        : 0;
      const perimeter = 2 * (room.bounds.w + room.bounds.h);

      roomOutlets
        .map((o) => ({
          o,
          pos: (this.#perimeterPos(room.bounds, o.x, o.y) - start + perimeter) % perimeter,
        }))
        .sort((a, b) => a.pos - b.pos)
        .forEach((entry, i) => {
          entry.o.label = `${room.name}${LABEL_SEPARATOR}${i + 1}`;
        });
    }
    // נקודות ללא חדר — בלי מזהה
    for (const o of outlets) {
      if (!o.roomId) o.label = null;
    }
  }

  /**
   * מיקום נקודה על היקף המלבן: מטילים אותה לנקודה הקרובה ביותר על
   * ההיקף ומחזירים את אורך הקשת בכיוון השעון מהפינה השמאלית-עליונה.
   */
  #perimeterPos(b, px, py) {
    // הצמדה לגבולות המלבן
    const cx = Math.min(Math.max(px, b.x), b.x + b.w);
    const cy = Math.min(Math.max(py, b.y), b.y + b.h);
    // המרחק לכל אחת מארבע הצלעות
    const dTop = Math.abs(cy - b.y);
    const dRight = Math.abs(cx - (b.x + b.w));
    const dBottom = Math.abs(cy - (b.y + b.h));
    const dLeft = Math.abs(cx - b.x);
    const m = Math.min(dTop, dRight, dBottom, dLeft);
    if (m === dTop) return cx - b.x;                                // צלע עליונה: שמאל⇐ימין
    if (m === dRight) return b.w + (cy - b.y);                      // ימנית: למעלה⇐למטה
    if (m === dBottom) return b.w + b.h + (b.x + b.w - cx);         // תחתונה: ימין⇐שמאל
    return 2 * b.w + b.h + (b.y + b.h - cy);                        // שמאלית: למטה⇐למעלה
  }

  /**
   * מספרי המעגלים (כמו 4/2) צמודים לסמלי השקעים; כמה תוויות צמודות
   * זו לזו = כמה שקעים באותה נקודה (4/2 + 4/3 ⇒ שקע כפול).
   */
  #attachCircuits(outlet, circuitLabels) {
    const near = circuitLabels
      .filter((c) => !c._used &&
        Math.hypot(c.x - outlet.x, c.y - outlet.y) <= CIRCUIT_ATTACH_RADIUS)
      .sort((a, b) =>
        Math.hypot(a.x - outlet.x, a.y - outlet.y) -
        Math.hypot(b.x - outlet.x, b.y - outlet.y))
      .slice(0, 4);
    if (!near.length) return;
    for (const c of near) c._used = true;
    outlet.circuit = near.map((c) => c.text).join(', ');
    if (near.length >= 2) outlet.quantity = near.length;
  }

  /**
   * זיהוי חדרים מפריטי ה-PDF — בלי OCR:
   * 1. הערות FreeText שהמשתמש כתב על ה-PDF (כל טקסט עברי) — ודאות מלאה.
   * 2. הערות מוטמעות של אוטוקאד (טקסט SHX ממופה-מקלדת) שתואמות את
   *    מילון שמות החדרים.
   */
  detectRoomsFromItems(textItems, projectId, pageSize) {
    const items = this.#dedupeItems(textItems);
    const labels = [];

    for (const item of items) {
      if (item.source === 'freetext') {
        const clean = item.text.trim();
        // כל טקסט עברי קצר שהמשתמש כתב = שם חדר
        if (/[א-ת]{2,}/.test(clean) && clean.length <= 20) {
          labels.push({ ...item, name: clean, certain: true });
        }
      } else if (item.source === 'annot') {
        const decoded = decodeShxHebrew(item.text).trim();
        // תווית חדר היא קצרה — מסנן משפטים כמו "ראה גליון ממ"דים"
        if (decoded.length > 12 || decoded.split(/\s+/).length > 2) continue;
        const entry = ROOM_LEXICON.find((e) => e.match.some((m) => decoded.includes(m)));
        if (entry) labels.push({ ...item, name: entry.name, certain: false });
      }
    }

    const rooms = [];
    for (const label of labels) {
      const w = Math.min(150, pageSize.width / 6);
      const h = Math.min(110, pageSize.height / 6);
      const x = Math.max(0, label.x - w / 2);
      const y = Math.max(0, label.y - h / 2);
      const dup = rooms.find(
        (r) => r.name === label.name &&
          Math.hypot(r.bounds.x - x, r.bounds.y - y) < 100,
      );
      if (dup) continue;
      rooms.push(new Room({ project_id: projectId, name: label.name, bounds: { x, y, w, h } }));
    }
    return rooms;
  }

  /**
   * הצעת מרחקים ממספרי המידות שמוטמעים בהערות ה-PDF (מדויק יותר מ-OCR).
   */
  suggestDistancesFromItems(textItems, outlets) {
    const numbers = this.#dedupeItems(textItems)
      .filter((i) => i.source === 'annot' && /^\d{2,3}$/.test(i.text))
      .map((i) => ({ value: parseInt(i.text, 10), x: i.x, y: i.y }))
      .filter((n) => n.value >= 10 && n.value <= 400);
    return this.suggestDistances(numbers, outlets);
  }

  /** הערות מופיעות לעיתים פעמיים ב-PDF — סינון כפילויות מדויקות */
  #dedupeItems(items) {
    const seen = [];
    return items.filter((it) => {
      const dup = seen.find(
        (s) => s.text === it.text && Math.hypot(s.x - it.x, s.y - it.y) < 3,
      );
      if (dup) return false;
      seen.push(it);
      return true;
    });
  }

  /**
   * הופך תוצאות OCR של שמות חדרים להצעות חדרים עם מלבן התחלתי.
   * @param {Array<{text,x,y,w,h}>} ocrWords מילים בקואורדינטות עמוד
   * @param {string} projectId
   * @param {{width,height}} pageSize
   * @returns {Room[]}
   */
  suggestRooms(ocrWords, projectId, pageSize) {
    const rooms = [];
    for (const word of ocrWords) {
      const clean = word.text.replace(/[^א-ת"׳״.]/g, '');
      if (clean.length < 2) continue;
      const entry = ROOM_LEXICON.find((e) => e.match.some((m) => clean.includes(m)));
      if (!entry) continue;

      // מלבן התחלתי סביב התווית — המשתמש ימתח אותו לגבולות החדר האמיתיים
      const w = Math.min(150, pageSize.width / 6);
      const h = Math.min(110, pageSize.height / 6);
      const x = Math.max(0, word.x + (word.w || 0) / 2 - w / 2);
      const y = Math.max(0, word.y + (word.h || 0) / 2 - h / 2);

      // לא מציעים חדר כפול באותו אזור
      const dup = rooms.find(
        (r) => r.name === entry.name &&
          Math.hypot(r.bounds.x - x, r.bounds.y - y) < 100,
      );
      if (dup) continue;

      rooms.push(new Room({
        project_id: projectId,
        name: entry.name,
        bounds: { x, y, w, h },
      }));
    }
    return rooms;
  }

  /**
   * מציע מרחק-מקיר לכל נקודה מתוך מספרי המידות שזוהו ב-OCR.
   * שיוך חמדני: הזוג (נקודה, מספר) הקרוב ביותר משויך ראשון, וכל מספר
   * משמש נקודה אחת בלבד. מרחק חיפוש מקסימלי: maxDist נקודות עמוד.
   * ממלא רק נקודות שאין להן ערך, ומחזיר את מספר ההצעות שמולאו.
   */
  suggestDistances(numberWords, outlets) {
    // מספרי מידה אמיתיים הם כמעט תמיד כפולות של 5 (30, 45, 100, 180...).
    // זה מסנן זיהויי-שווא של מספרי מעגלים ("2/1" שנקרא כ-"21").
    const candidates = numberWords.filter((n) => n.value % 5 === 0);
    const ALIGN_TOL = 14; // סטייה מותרת מקו השקע (נקודות עמוד)
    const pairs = [];
    for (const o of outlets) {
      if (o.cornerDistanceCm != null) continue;
      for (const n of candidates) {
        const dx = Math.abs(o.x - n.x);
        const dy = Math.abs(o.y - n.y);
        // תווית המידה יושבת על קו המידה — כלומר באותה שורה או עמודה
        // כמו השקע (הקו יוצא מהקיר אל השקע לאורך ציר אחד).
        if (Math.min(dx, dy) > ALIGN_TOL) continue;
        const d = Math.hypot(dx, dy);
        // התווית באמצע הקו, ולכן המרחק אליה גדל עם ערך המידה
        // (בקנה מידה 1:50, מידה של V ס"מ ⇒ התווית עד ~0.3V+25 נק' מהשקע)
        if (d > 25 + n.value * 0.45) continue;
        pairs.push({ o, n, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    const usedOutlets = new Set();
    const usedNumbers = new Set();
    let filled = 0;
    for (const { o, n } of pairs) {
      if (usedOutlets.has(o.id) || usedNumbers.has(n)) continue;
      o.cornerDistanceCm = n.value;
      usedOutlets.add(o.id);
      usedNumbers.add(n);
      filled++;
    }
    return filled;
  }

  /**
   * חיבור הסמלים הגיאומטריים (עיגולים/משולשים מ-SymbolDetector) לנקודות
   * שזוהו מהטקסט — לפי קרבה פיזית בדף:
   * 1. סמלים צמודים מקובצים לאשכול (שקע כפול = שני עיגולים צמודים).
   * 2. כל נקודה "נצמדת" לאשכול הקרוב אליה: המיקום מתעדכן למרכז האשכול
   *    האמיתי (במקום מיקום התווית) והכמות נלקחת מגודל האשכול.
   * @returns {{snapped:number, clusters:number}}
   */
  fuseSymbols(outlets, allSymbols, { snapDist = 30 } = {}) {
    // מצמידים רק לעיגולים — משולשים בשרטוטים אלה הם לרוב חיצי קווי מידה
    const symbols = allSymbols.filter((s) => s.shape === 'circle');
    if (!symbols.length) return { snapped: 0, clusters: 0 };

    // 1. אשכולות בקישור-יחיד: סמלים במרחק עד ~2 קטרים זה מזה
    const clusters = [];
    const used = new Array(symbols.length).fill(false);
    for (let i = 0; i < symbols.length; i++) {
      if (used[i]) continue;
      const cluster = [symbols[i]];
      used[i] = true;
      for (let j = 0; j < cluster.length; j++) {
        const a = cluster[j];
        for (let k = 0; k < symbols.length; k++) {
          if (used[k]) continue;
          const b = symbols[k];
          const gap = Math.hypot(a.x - b.x, a.y - b.y);
          if (gap <= (a.r + b.r) * 2.2) {
            cluster.push(b);
            used[k] = true;
          }
        }
      }
      const cx = cluster.reduce((s, c) => s + c.x, 0) / cluster.length;
      const cy = cluster.reduce((s, c) => s + c.y, 0) / cluster.length;
      clusters.push({ x: cx, y: cy, size: cluster.length, symbols: cluster });
    }

    // 2. הצמדה חמדנית: הזוג (נקודה, אשכול) הקרוב ביותר משויך ראשון
    const pairs = [];
    for (const o of outlets) {
      for (const c of clusters) {
        const d = Math.hypot(o.x - c.x, o.y - c.y);
        if (d <= snapDist) pairs.push({ o, c, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    const usedOutlets = new Set();
    const usedClusters = new Set();
    let snapped = 0;
    for (const { o, c } of pairs) {
      if (usedOutlets.has(o.id) || usedClusters.has(c)) continue;
      usedOutlets.add(o.id);
      usedClusters.add(c);
      o.x = c.x;
      o.y = c.y;
      if (c.size > 1 && o.quantity === 1) o.quantity = Math.min(4, c.size);
      snapped++;
    }
    return { snapped, clusters: clusters.length };
  }

  /** משייך כל שקע לחדר שמכיל אותו גיאומטרית (או null) */
  assignOutletsToRooms(outlets, rooms) {
    const validIds = new Set(rooms.map((r) => r.id));
    for (const o of outlets) {
      // ניקוי מזהה חדר "יתום" — חדר שהוחלף/נמחק (מונע הפרת FK בשמירה)
      if (o.roomId && !validIds.has(o.roomId)) o.roomId = null;
      const room = rooms.find((r) => r.contains(o.x, o.y));
      if (room) o.roomId = room.id;
    }
  }

  #nearest(items, x, y, maxDist) {
    let best = null;
    let bestD = maxDist;
    for (const it of items) {
      const d = Math.hypot(it.x - x, it.y - y);
      if (d <= bestD) { bestD = d; best = it; }
    }
    return best;
  }
}
