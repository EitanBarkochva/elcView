// ===== מסך ביקורת בשטח — שלבים ב', ג', ד' =====
//
// שלב ב': המצלמה מזהה קופסאות כתומות; הקשה על קופסה ("הצבעה על השקע")
//          מקפיאה את הפריים ומודדת גובה מהרצפה ומרחק מפינת הקיר.
//          אם הזיהוי האוטומטי של הרצפה/פינה טעה — מקישים ידנית על הנקודה.
// שלב ג': המדידה מושווית לנקודה המתאימה בשרטוט לפי סטייה מותרת ⇒ ✓/✗.
// שלב ד': מצב סריקה אוטומטית — קופסה שמזוהה יציב נמדדת ומסומנת לבד.

import { VISION } from '../config.js';
import { OrangeBoxDetector } from '../services/vision.js';
import { MeasurementEngine } from '../services/measure.js';

const LOOP_MS = 180;

export class InspectionView {
  /**
   * @param {object} els אלמנטים מה-DOM
   * @param {(outlet, patch) => void} onOutletUpdate שמירה ל-DB
   */
  constructor(els, onOutletUpdate) {
    this.els = els;
    this.onOutletUpdate = onOutletUpdate;

    this.detector = new OrangeBoxDetector();
    this.measurer = new MeasurementEngine();

    this.stream = null;
    this.rooms = [];
    this.outlets = [];

    this.workCanvas = document.createElement('canvas');   // פריים מוקטן לזיהוי שוטף
    this.fullCanvas = document.createElement('canvas');   // פריים מלא למדידה
    this.loopTimer = null;

    this.boxes = [];          // תיבות אחרונות בקואורדינטות הווידאו
    this.frozen = null;       // {frame, box, measure, matched, ok} במצב מדידה
    this.tapMode = null;      // 'floor' | 'corner' — תיקון ידני בהקשה
    this.autoMode = false;
    this.stability = { cx: 0, cy: 0, count: 0 };
    this.autoBanner = null;   // תוצאת מדידה אוטומטית להצגה זמנית

    this.els.toggleBtn.addEventListener('click', () => this.toggleCamera());
    this.els.roomSelect.addEventListener('change', () => this.#onRoomChange());
    this.els.autoToggle.addEventListener('click', () => this.#toggleAutoMode());
    this.els.overlay.addEventListener('pointerdown', (e) => this.#onTap(e));
  }

  setData(rooms, outlets) {
    this.rooms = rooms;
    this.outlets = outlets;
    const sel = this.els.roomSelect;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const r of rooms) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      sel.appendChild(opt);
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    this.#renderChecklist();
  }

  get tolerance() {
    return parseInt(this.els.toleranceInput.value, 10) || VISION.TOLERANCE_CM;
  }

  #roomOutlets() {
    const roomId = this.els.roomSelect.value;
    return this.outlets.filter((o) => o.roomId === roomId);
  }

  // ---------- מצלמה ולולאת זיהוי ----------

  async toggleCamera() {
    if (this.stream) { this.stopCamera(); return; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      const video = this.els.video;
      video.srcObject = this.stream;
      await new Promise((res) => { video.onloadedmetadata = res; });
      await video.play();

      const W = video.videoWidth;
      const H = video.videoHeight;
      this.els.overlay.width = W;
      this.els.overlay.height = H;
      this.workCanvas.width = VISION.DETECT_WIDTH;
      this.workCanvas.height = Math.round(H * (VISION.DETECT_WIDTH / W));
      this.fullCanvas.width = W;
      this.fullCanvas.height = H;

      video.classList.remove('hidden');
      this.els.overlay.classList.remove('hidden');
      this.els.placeholder.classList.add('hidden');
      this.els.autoToggle.classList.remove('hidden');
      this.els.toleranceWrap.classList.remove('hidden');
      this.els.toggleBtn.textContent = '⏹ סגור מצלמה';

      this.loopTimer = setInterval(() => this.#tick(), LOOP_MS);
    } catch (err) {
      alert('לא ניתן לפתוח את המצלמה: ' + err.message);
    }
  }

  stopCamera() {
    clearInterval(this.loopTimer);
    this.loopTimer = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.frozen = null;
    this.autoMode = false;
    this.els.video.srcObject = null;
    this.els.video.classList.add('hidden');
    this.els.overlay.classList.add('hidden');
    this.els.placeholder.classList.remove('hidden');
    this.els.autoToggle.classList.add('hidden');
    this.els.toleranceWrap.classList.add('hidden');
    this.els.measurePanel.classList.add('hidden');
    this.els.toggleBtn.textContent = '📷 פתח מצלמה';
    this.els.autoToggle.textContent = '▶ סריקה אוטומטית';
  }

  /** פעימת זיהוי: מאתר קופסאות ומצייר; במצב אוטומטי גם מודד */
  #tick() {
    if (!this.stream || this.frozen) return;
    const video = this.els.video;
    const wc = this.workCanvas;
    const ctx = wc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, wc.width, wc.height);
    const imageData = ctx.getImageData(0, 0, wc.width, wc.height);

    const k = video.videoWidth / wc.width; // המרה לקואורדינטות וידאו
    this.boxes = this.detector.detect(imageData).map((b) => ({
      x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k,
      cx: b.cx * k, cy: b.cy * k, area: b.area * k * k,
    }));

    if (this.autoMode && this.boxes.length) this.#autoStep(this.boxes[0]);

    this.#drawOverlay();
  }

  #drawOverlay() {
    const ctx = this.els.overlay.getContext('2d');
    const { width: W, height: H } = this.els.overlay;
    ctx.clearRect(0, 0, W, H);

    const lw = Math.max(2, W / 300);
    for (const b of this.boxes) {
      ctx.strokeStyle = '#ff8f00';
      ctx.lineWidth = lw;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    if (this.boxes.length && !this.autoMode) {
      this.#label(ctx, 'הקש על הקופסה למדידה', this.boxes[0].cx, this.boxes[0].y - 10, '#ff8f00');
    }

    // תוצאת מדידה אוטומטית אחרונה (שלב ד')
    if (this.autoBanner && Date.now() < this.autoBanner.until) {
      this.#drawMeasureMarks(ctx, this.autoBanner.box, this.autoBanner.measure);
      const icon = this.autoBanner.ok ? '✓' : '✗';
      const color = this.autoBanner.ok ? '#2e7d32' : '#c62828';
      ctx.font = `bold ${Math.round(W / 12)}px Arial`;
      ctx.fillStyle = color;
      ctx.fillText(icon, this.autoBanner.box.x + this.autoBanner.box.w + 12, this.autoBanner.box.cy);
    }
  }

  /** ציור קווי המדידה: אנך לרצפה ואופק לפינה */
  #drawMeasureMarks(ctx, box, measure) {
    const lw = Math.max(2, this.els.overlay.width / 400);
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#1565c0';
    ctx.setLineDash([8, 6]);
    if (measure.floorY != null) {
      ctx.beginPath();
      ctx.moveTo(box.cx, box.cy);
      ctx.lineTo(box.cx, measure.floorY);
      ctx.stroke();
      this.#label(ctx, `${measure.heightCm} ס"מ`, box.cx + 10, (box.cy + measure.floorY) / 2, '#1565c0');
    }
    if (measure.cornerX != null) {
      ctx.beginPath();
      ctx.moveTo(box.cx, box.cy);
      ctx.lineTo(measure.cornerX, box.cy);
      ctx.stroke();
      this.#label(ctx, `${measure.cornerCm} ס"מ`, (box.cx + measure.cornerX) / 2, box.cy - 12, '#6a1b9a');
    }
    ctx.setLineDash([]);
  }

  #label(ctx, text, x, y, color) {
    const size = Math.max(14, Math.round(this.els.overlay.width / 45));
    ctx.font = `bold ${size}px Arial`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(x - 4, y - size, w + 8, size + 6);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  // ---------- שלב ב': הצבעה על שקע ⇒ מדידה ----------

  #onTap(e) {
    const rect = this.els.overlay.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (this.els.overlay.width / rect.width);
    const y = (e.clientY - rect.top) * (this.els.overlay.height / rect.height);

    // תיקון ידני של רצפה/פינה במצב הקפאה
    if (this.frozen && this.tapMode) {
      const m = this.frozen.measure;
      const pts = this.measurer.measureFromPoints(
        this.frozen.box, m.mmpp,
        this.tapMode === 'floor' ? { x, y } : (m.floorY != null ? { x: 0, y: m.floorY } : null),
        this.tapMode === 'corner' ? { x, y } : (m.cornerX != null ? { x: m.cornerX, y: 0 } : null),
      );
      this.frozen.measure = { ...m, ...pts };
      this.tapMode = null;
      this.#compareFrozen();
      this.#drawFrozen();
      this.#renderMeasurePanel();
      return;
    }

    if (this.frozen) return; // בהקפאה — פעולות דרך הכפתורים בלבד

    // הקשה על קופסה מזוהה ⇒ הקפאה ומדידה
    const hit = this.boxes.find((b) =>
      x >= b.x - b.w * 0.5 && x <= b.x + b.w * 1.5 &&
      y >= b.y - b.h * 0.5 && y <= b.y + b.h * 1.5);
    if (hit) this.#freezeAndMeasure(hit);
  }

  #freezeAndMeasure(box) {
    const video = this.els.video;
    const fc = this.fullCanvas;
    const ctx = fc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, fc.width, fc.height);
    const frame = ctx.getImageData(0, 0, fc.width, fc.height);

    const measure = this.measurer.measureAuto(frame, box);
    this.frozen = { frame, box, measure, matched: null, ok: false };
    this.#compareFrozen();
    this.#drawFrozen();
    this.#renderMeasurePanel();
  }

  #drawFrozen() {
    const ctx = this.els.overlay.getContext('2d');
    ctx.putImageData(this.frozen.frame, 0, 0); // תצוגה קפואה
    const b = this.frozen.box;
    ctx.strokeStyle = '#ff8f00';
    ctx.lineWidth = Math.max(2, this.els.overlay.width / 300);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    this.#drawMeasureMarks(ctx, b, this.frozen.measure);
  }

  #unfreeze() {
    this.frozen = null;
    this.tapMode = null;
    this.els.measurePanel.classList.add('hidden');
  }

  // ---------- שלב ג': השוואה לשרטוט ----------

  /**
   * מוצא את הנקודה בשרטוט שהכי מתאימה למדידה (לפי גובה),
   * וקובע התאמה לפי הסטייה המותרת.
   */
  #compare(measure) {
    const candidates = this.#roomOutlets().filter((o) => o.heightCm != null);
    if (!candidates.length || measure.heightCm == null) {
      return { matched: null, ok: false, reason: 'אין נקודות עם גובה בחדר זה או שהרצפה לא זוהתה' };
    }
    let matched = candidates[0];
    for (const o of candidates) {
      if (Math.abs(o.heightCm - measure.heightCm) < Math.abs(matched.heightCm - measure.heightCm)) {
        matched = o;
      }
    }
    const tol = this.tolerance;
    const heightOk = Math.abs(matched.heightCm - measure.heightCm) <= tol;
    const cornerKnown = matched.cornerDistanceCm != null && measure.cornerCm != null;
    const cornerOk = !cornerKnown ||
      Math.abs(matched.cornerDistanceCm - measure.cornerCm) <= tol;
    return { matched, ok: heightOk && cornerOk, heightOk, cornerOk, cornerKnown };
  }

  #compareFrozen() {
    const res = this.#compare(this.frozen.measure);
    this.frozen.matched = res.matched;
    this.frozen.ok = res.ok;
    this.frozen.compareInfo = res;
  }

  /** שמירת המדידה על הנקודה שהותאמה */
  #confirmFrozen(markDone) {
    const f = this.frozen;
    if (!f?.matched) return;
    const o = f.matched;
    o.measuredHeightCm = f.measure.heightCm;
    o.measuredCornerCm = f.measure.cornerCm;
    o.measureStatus = f.ok ? 'ok' : 'mismatch';
    if (markDone) o.done = true;
    this.onOutletUpdate(o, {
      measured_height_cm: o.measuredHeightCm,
      measured_corner_cm: o.measuredCornerCm,
      measure_status: o.measureStatus,
      ...(markDone ? { done: true } : {}),
    });
    this.#renderChecklist();
    this.#unfreeze();
  }

  // ---------- שלב ד': סריקה אוטומטית ----------

  #toggleAutoMode() {
    this.autoMode = !this.autoMode;
    this.els.autoToggle.textContent = this.autoMode ? '⏸ עצור סריקה' : '▶ סריקה אוטומטית';
    this.els.autoToggle.classList.toggle('tap-active', this.autoMode);
    this.stability = { cx: 0, cy: 0, count: 0 };
    if (this.autoMode) this.#unfreeze();
  }

  #autoStep(box) {
    // דרושה יציבות: הקופסה כמעט לא זזה כמה פריימים ברצף
    const moved = Math.hypot(box.cx - this.stability.cx, box.cy - this.stability.cy);
    this.stability.cx = box.cx;
    this.stability.cy = box.cy;
    if (moved > VISION.STABLE_MOVE_PX) {
      this.stability.count = 0;
      return;
    }
    this.stability.count++;
    if (this.stability.count < VISION.STABLE_FRAMES) return;
    this.stability.count = -30; // המתנה לפני המדידה הבאה (~5 שניות)

    const fc = this.fullCanvas;
    const ctx = fc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.els.video, 0, 0, fc.width, fc.height);
    const frame = ctx.getImageData(0, 0, fc.width, fc.height);
    const measure = this.measurer.measureAuto(frame, box);
    if (measure.heightCm == null) return; // בלי קו רצפה אין מדידה

    const res = this.#compare(measure);
    this.autoBanner = { box, measure, ok: res.ok, until: Date.now() + 3000 };

    if (res.matched) {
      const o = res.matched;
      o.measuredHeightCm = measure.heightCm;
      o.measuredCornerCm = measure.cornerCm;
      o.measureStatus = res.ok ? 'ok' : 'mismatch';
      if (res.ok && !o.done) o.done = true;
      this.onOutletUpdate(o, {
        measured_height_cm: o.measuredHeightCm,
        measured_corner_cm: o.measuredCornerCm,
        measure_status: o.measureStatus,
        ...(res.ok ? { done: true } : {}),
      });
      this.#renderChecklist();
    }
  }

  // ---------- פאנל המדידה ----------

  #renderMeasurePanel() {
    const panel = this.els.measurePanel;
    const f = this.frozen;
    if (!f) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = '';

    const values = document.createElement('div');
    values.className = 'measure-values';
    values.innerHTML = `
      <span>⬆ גובה מהרצפה: <b>${f.measure.heightCm != null ? f.measure.heightCm + ' ס"מ' : 'לא זוהה'}</b></span>
      <span>↔ מרחק מפינה: <b>${f.measure.cornerCm != null ? f.measure.cornerCm + ' ס"מ' : 'לא זוהה'}</b></span>`;
    panel.appendChild(values);

    const cmp = document.createElement('div');
    const info = f.compareInfo;
    if (f.matched) {
      cmp.className = `compare ${f.ok ? 'ok' : 'mismatch'}`;
      const parts = [`הותאם ל: ${f.matched.kind} H=${f.matched.heightCm}`];
      if (info.cornerKnown) parts.push(`פינה מתוכננת: ${f.matched.cornerDistanceCm} ס"מ`);
      parts.push(f.ok ? `✓ תואם לשרטוט (עד ${this.tolerance} ס"מ)` : '✗ לא תואם לשרטוט');
      cmp.textContent = parts.join(' · ');
    } else {
      cmp.className = 'compare mismatch';
      cmp.textContent = info?.reason || 'לא נמצאה נקודה להשוואה';
    }
    panel.appendChild(cmp);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const mkBtn = (text, cls, fn) => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.textContent = text;
      b.addEventListener('click', fn);
      actions.appendChild(b);
      return b;
    };
    const floorBtn = mkBtn('🎯 הקש על הרצפה', '', () => {
      this.tapMode = this.tapMode === 'floor' ? null : 'floor';
      floorBtn.classList.toggle('tap-active', this.tapMode === 'floor');
      cornerBtn.classList.remove('tap-active');
    });
    const cornerBtn = mkBtn('🎯 הקש על הפינה', '', () => {
      this.tapMode = this.tapMode === 'corner' ? null : 'corner';
      cornerBtn.classList.toggle('tap-active', this.tapMode === 'corner');
      floorBtn.classList.remove('tap-active');
    });
    if (f.matched) {
      mkBtn('✔ אשר וסמן בוצע', 'primary', () => this.#confirmFrozen(true));
      mkBtn('שמור מדידה בלבד', '', () => this.#confirmFrozen(false));
    }
    mkBtn('↩ המשך סריקה', '', () => this.#unfreeze());
    panel.appendChild(actions);
  }

  // ---------- רשימת הנקודות של החדר ----------

  #onRoomChange() {
    this.#unfreeze();
    this.#renderChecklist();
  }

  #renderChecklist() {
    const list = this.#roomOutlets();
    const wrap = this.els.checklist;
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<p class="muted">אין נקודות רשומות בחדר זה.</p>';
      return;
    }
    for (const o of list) {
      const div = document.createElement('div');
      div.className = 'check-item';
      const icon = o.measureStatus === 'ok' ? '✅'
        : o.measureStatus === 'mismatch' ? '❌'
        : o.done ? '☑' : '⬜';
      const measured = o.measuredHeightCm != null
        ? ` · נמדד: ${o.measuredHeightCm} ס"מ${o.measuredCornerCm != null ? ` / פינה ${o.measuredCornerCm} ס"מ` : ''}`
        : '';
      div.innerHTML = `
        <span class="status">${icon}</span>
        <span>${o.kind}</span>
        <span class="muted">מתוכנן: גובה ${o.heightCm ?? '?'} ס"מ, פינה ${o.cornerDistanceCm ?? '?'} ס"מ${measured}</span>`;
      wrap.appendChild(div);
    }
  }
}
