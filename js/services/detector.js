// ===== מנוע הזיהוי — הפיכת טקסט השרטוט לרשימת שקעים =====
//
// שכבת הטקסט של שרטוטי חשמל (ייצוא אוטוקאד) מכילה תוויות אמינות:
//   H=45 / H=120 ...  ⇒ נקודת חשמל עם גובה מהרצפה בס"מ
//   TV / T            ⇒ סוג הנקודה (טלוויזיה / תקשורת-טלפון)
// שמות חדרים ומספרי מידות מצוירים לרוב כקווים (פונט SHX) — בהם מטפל ה-OCR.

import { Outlet, Room } from '../models.js';
import { ROOM_LEXICON } from '../config.js';

const HEIGHT_RE = /^H\s*=\s*(\d{1,3})$/i;
const KIND_LABELS = { TV: 'TV', T: 'תקשורת' };
// מרחק מקסימלי (בנקודות PDF) לשיוך תווית סוג לנקודת גובה
const KIND_ATTACH_RADIUS = 25;

export class PlanDetector {
  /**
   * @param {Array<{text,x,y}>} textItems פריטי טקסט מ-PdfService
   * @param {string} projectId
   * @returns {Outlet[]}
   */
  detectOutlets(textItems, projectId) {
    const heightLabels = [];
    const kindLabels = [];

    for (const item of textItems) {
      const m = item.text.match(HEIGHT_RE);
      if (m) {
        heightLabels.push({ ...item, height: parseInt(m[1], 10) });
      } else if (KIND_LABELS[item.text.toUpperCase()]) {
        kindLabels.push({ ...item, kind: KIND_LABELS[item.text.toUpperCase()] });
      }
    }

    const outlets = heightLabels.map((h) => {
      const nearKind = this.#nearest(kindLabels, h.x, h.y, KIND_ATTACH_RADIUS);
      return new Outlet({
        project_id: projectId,
        kind: nearKind ? nearKind.kind : 'שקע',
        height_cm: h.height,
        x: h.x,
        y: h.y,
      });
    });

    // תוויות TV/T שלא נקשרו לגובה — נקודה עצמאית ללא גובה ידוע
    for (const k of kindLabels) {
      const attached = outlets.some(
        (o) => Math.hypot(o.x - k.x, o.y - k.y) <= KIND_ATTACH_RADIUS,
      );
      if (!attached) {
        outlets.push(new Outlet({
          project_id: projectId, kind: k.kind, x: k.x, y: k.y,
        }));
      }
    }
    return outlets;
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

  /** משייך כל שקע לחדר שמכיל אותו גיאומטרית (או null) */
  assignOutletsToRooms(outlets, rooms) {
    for (const o of outlets) {
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
