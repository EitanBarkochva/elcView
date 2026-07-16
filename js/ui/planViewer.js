// ===== מציג השרטוט — קנבס + שכבת עריכה אינטראקטיבית =====
//
// מבנה: viewport (חלון) ⇐ world (מוזז ומוגדל ב-CSS transform)
//        ⇐ canvas (רינדור ה-PDF) + overlay (סיכות שקעים ומלבני חדרים).
// כל האלמנטים באוברליי ממוקמים בפיקסלים של הקנבס; הקואורדינטות במודל
// נשמרות בנקודות עמוד PDF וההמרה נעשית דרך RENDER_SCALE.

import { RENDER_SCALE } from '../config.js';

const DRAG_THRESHOLD = 5; // פיקסלים — מבחין בין לחיצה לגרירה

export class PlanViewer {
  /**
   * @param {object} els  {viewport, world, canvas, overlay}
   * @param {object} callbacks {
   *   onSelectOutlet(outlet|null), onSelectRoom(room|null),
   *   onAddOutlet(x,y), onAddRoom(bounds), onGeometryChanged()
   * }
   */
  constructor(els, callbacks, opts = {}) {
    this.els = els;
    this.cb = callbacks;
    // טקסט הסיכה: ברירת מחדל H=גובה; בשרטוט החשמלי — המזהה (מטבח-1)
    this.pinText = opts.pinText
      || ((o) => (o.heightCm != null ? `H=${o.heightCm}` : o.kind));
    this.pinColor = opts.pinColor || null; // צבע מותאם לפי סוג (שרטוט חשמלי)
    this.showRooms = opts.showRooms !== false;
    this.readOnly = false; // לצופים: בחירה בלבד, בלי גרירה/הוספה

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.mode = 'pan'; // pan | addOutlet | addRoom

    this.rooms = [];
    this.outlets = [];
    this.selected = null; // {type:'outlet'|'room', id}

    this.pinEls = new Map();
    this.roomEls = new Map();

    this.#bindViewportEvents();
  }

  // ---------- API ----------

  setMode(mode) {
    this.mode = mode;
    this.els.viewport.classList.toggle('adding', mode !== 'pan');
  }

  setData(rooms, outlets) {
    this.rooms = rooms;
    this.outlets = outlets;
    this.renderAll();
  }

  renderAll() {
    this.els.overlay.innerHTML = '';
    this.pinEls.clear();
    this.roomEls.clear();
    if (this.showRooms) {
      for (const room of this.rooms) this.#renderRoom(room);
    }
    for (const outlet of this.outlets) this.#renderPin(outlet);
    this.#applySelection();
  }

  select(type, id) {
    this.selected = id ? { type, id } : null;
    this.#applySelection();
    if (!id) {
      this.cb.onSelectOutlet(null);
      return;
    }
    if (type === 'outlet') {
      this.cb.onSelectOutlet(this.outlets.find((o) => o.id === id) || null);
    } else {
      this.cb.onSelectRoom(this.rooms.find((r) => r.id === id) || null);
    }
  }

  /** רענון סיכה בודדת אחרי עריכה בפאנל */
  refreshOutlet(outlet) {
    const el = this.pinEls.get(outlet.id);
    if (el) this.#stylePin(el, outlet);
  }

  refreshRoom(room) {
    const el = this.roomEls.get(room.id);
    if (el) el.querySelector('.room-name').textContent = room.name;
  }

  removeElement(type, id) {
    const map = type === 'outlet' ? this.pinEls : this.roomEls;
    map.get(id)?.remove();
    map.delete(id);
    if (this.selected?.id === id) this.select(null, null);
  }

  fit() {
    const vw = this.els.viewport.clientWidth;
    const vh = this.els.viewport.clientHeight;
    const cw = this.els.canvas.width;
    const ch = this.els.canvas.height;
    if (!cw || !ch) return;
    this.scale = Math.min(vw / cw, vh / ch) * 0.97;
    this.tx = (vw - cw * this.scale) / 2;
    this.ty = (vh - ch * this.scale) / 2;
    this.#applyTransform();
  }

  zoomBy(factor) {
    const vw = this.els.viewport.clientWidth / 2;
    const vh = this.els.viewport.clientHeight / 2;
    this.#zoomAt(vw, vh, factor);
  }

  // ---------- רינדור אלמנטים ----------

  #renderPin(outlet) {
    const el = document.createElement('div');
    el.className = 'pin';
    this.#stylePin(el, outlet);
    el.addEventListener('pointerdown', (e) => this.#onPinPointerDown(e, outlet, el));
    this.els.overlay.appendChild(el);
    this.pinEls.set(outlet.id, el);
  }

  #stylePin(el, outlet) {
    el.className = `pin kind-${outlet.kind}${outlet.done ? ' done' : ''}`;
    if (this.selected?.type === 'outlet' && this.selected.id === outlet.id) {
      el.classList.add('selected');
    }
    const base = this.pinText(outlet);
    el.textContent = outlet.quantity > 1 ? `${base} ×${outlet.quantity}` : base;
    if (this.pinColor) el.style.background = this.pinColor(outlet);
    const px = outlet.x * RENDER_SCALE;
    const py = outlet.y * RENDER_SCALE;
    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
    this.#counterScale(el);
  }

  #renderRoom(room) {
    if (!room.bounds) return;
    const el = document.createElement('div');
    el.className = 'room-rect';
    const name = document.createElement('span');
    name.className = 'room-name';
    name.textContent = room.name;
    const resize = document.createElement('span');
    resize.className = 'room-resize';
    el.append(name, resize);

    // סמן הפתח — נקודת תחילת המספור של החלל
    if (room.entrance && room.bounds) {
      const door = document.createElement('span');
      door.className = 'room-entrance';
      door.title = 'פתח החלל — תחילת המספור';
      door.textContent = '🚪';
      door.style.left = `${(room.entrance.x - room.bounds.x) * RENDER_SCALE}px`;
      door.style.top = `${(room.entrance.y - room.bounds.y) * RENDER_SCALE}px`;
      el.appendChild(door);
    }

    this.#styleRoom(el, room);

    // בחירה בלחיצה על המסגרת, גרירה מהתגית, שינוי גודל מהידית
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.select('room', room.id);
    });
    name.addEventListener('pointerdown', (e) => this.#onRoomDrag(e, room, el, 'move'));
    resize.addEventListener('pointerdown', (e) => this.#onRoomDrag(e, room, el, 'resize'));

    this.els.overlay.appendChild(el);
    this.roomEls.set(room.id, el);
  }

  #styleRoom(el, room) {
    const b = room.bounds;
    el.style.left = `${b.x * RENDER_SCALE}px`;
    el.style.top = `${b.y * RENDER_SCALE}px`;
    el.style.width = `${b.w * RENDER_SCALE}px`;
    el.style.height = `${b.h * RENDER_SCALE}px`;
  }

  #applySelection() {
    for (const [id, el] of this.pinEls) {
      el.classList.toggle('selected', this.selected?.type === 'outlet' && this.selected.id === id);
    }
    for (const [id, el] of this.roomEls) {
      el.classList.toggle('selected', this.selected?.type === 'room' && this.selected.id === id);
    }
  }

  // ---------- טרנספורמציה וזום ----------

  #applyTransform() {
    this.els.world.style.transform =
      `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    // הסיכות נשארות בגודל קריא בכל רמת זום
    for (const el of this.pinEls.values()) this.#counterScale(el);
  }

  #counterScale(el) {
    const inv = Math.min(2.5, Math.max(0.6, 1 / this.scale));
    el.style.transform = `translate(-50%, -50%) scale(${inv})`;
  }

  #zoomAt(vx, vy, factor) {
    const newScale = Math.min(8, Math.max(0.1, this.scale * factor));
    const real = newScale / this.scale;
    this.tx = vx - (vx - this.tx) * real;
    this.ty = vy - (vy - this.ty) * real;
    this.scale = newScale;
    this.#applyTransform();
  }

  /** קואורדינטות מסך ⇒ נקודות עמוד PDF */
  #toPage(clientX, clientY) {
    const rect = this.els.viewport.getBoundingClientRect();
    const cx = (clientX - rect.left - this.tx) / this.scale;
    const cy = (clientY - rect.top - this.ty) / this.scale;
    return { x: cx / RENDER_SCALE, y: cy / RENDER_SCALE };
  }

  // ---------- אירועי עכבר/מגע ----------

  #bindViewportEvents() {
    const vp = this.els.viewport;

    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      this.#zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    // מפת מצביעים פעילים — לתמיכה בצביטת זום במובייל
    this.activePointers = new Map();

    vp.addEventListener('pointerdown', (e) => this.#onViewportPointerDown(e));
    vp.addEventListener('pointermove', (e) => this.#onViewportPointerMove(e));
    vp.addEventListener('pointerup', (e) => this.#onViewportPointerUp(e));
    vp.addEventListener('pointercancel', (e) => this.activePointers.delete(e.pointerId));
  }

  #onViewportPointerDown(e) {
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.els.viewport.setPointerCapture(e.pointerId);

    if (this.activePointers.size === 2) {
      // צביטה — מבטל כל פעולה אחרת
      this.gesture = { type: 'pinch', startDist: this.#pinchDist(), startScale: this.scale };
      return;
    }

    if (this.mode === 'addRoom') {
      const start = this.#toPage(e.clientX, e.clientY);
      const band = document.createElement('div');
      band.className = 'room-rect';
      this.els.overlay.appendChild(band);
      this.gesture = { type: 'band', start, band };
    } else {
      // pan (וגם לחיצה בודדת ב-addOutlet נקבעת ב-pointerup)
      this.gesture = {
        type: 'pan', startX: e.clientX, startY: e.clientY,
        startTx: this.tx, startTy: this.ty, moved: false,
      };
    }
  }

  #onViewportPointerMove(e) {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const g = this.gesture;
    if (!g) return;

    if (g.type === 'pinch' && this.activePointers.size === 2) {
      const factor = this.#pinchDist() / g.startDist;
      const pts = [...this.activePointers.values()];
      const rect = this.els.viewport.getBoundingClientRect();
      const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
      const target = Math.min(8, Math.max(0.1, g.startScale * factor));
      this.#zoomAt(cx, cy, target / this.scale);
      return;
    }

    if (g.type === 'pan') {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) g.moved = true;
      if (g.moved && this.mode === 'pan') {
        this.tx = g.startTx + dx;
        this.ty = g.startTy + dy;
        this.#applyTransform();
      }
    } else if (g.type === 'band') {
      const cur = this.#toPage(e.clientX, e.clientY);
      const b = this.#normRect(g.start, cur);
      g.bounds = b;
      g.band.style.left = `${b.x * RENDER_SCALE}px`;
      g.band.style.top = `${b.y * RENDER_SCALE}px`;
      g.band.style.width = `${b.w * RENDER_SCALE}px`;
      g.band.style.height = `${b.h * RENDER_SCALE}px`;
    }
  }

  #onViewportPointerUp(e) {
    this.activePointers.delete(e.pointerId);
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;

    if (g.type === 'band') {
      g.band.remove();
      if (g.bounds && g.bounds.w > 5 && g.bounds.h > 5) {
        this.cb.onAddRoom(g.bounds);
      }
      return;
    }

    if (g.type === 'pan' && !g.moved) {
      // לחיצה נקייה על רקע השרטוט
      if (this.mode === 'addOutlet') {
        const p = this.#toPage(e.clientX, e.clientY);
        this.cb.onAddOutlet(p.x, p.y);
      } else if (this.mode === 'nameRoom') {
        const p = this.#toPage(e.clientX, e.clientY);
        this.cb.onNameRoomAt(p.x, p.y, e.clientX, e.clientY);
      } else if (this.mode === 'setEntrance') {
        const p = this.#toPage(e.clientX, e.clientY);
        this.cb.onSetEntrance(p.x, p.y);
      } else {
        this.select(null, null); // ביטול בחירה
      }
    }
  }

  #onPinPointerDown(e, outlet, el) {
    e.stopPropagation();
    if (this.readOnly) {
      this.select('outlet', outlet.id);
      return;
    }
    el.setPointerCapture(e.pointerId);
    const startPage = this.#toPage(e.clientX, e.clientY);
    const orig = { x: outlet.x, y: outlet.y };
    let moved = false;

    const onMove = (ev) => {
      const cur = this.#toPage(ev.clientX, ev.clientY);
      const dx = cur.x - startPage.x;
      const dy = cur.y - startPage.y;
      if (Math.hypot(dx * RENDER_SCALE * this.scale, dy * RENDER_SCALE * this.scale) > DRAG_THRESHOLD) {
        moved = true;
      }
      if (moved) {
        outlet.x = orig.x + dx;
        outlet.y = orig.y + dy;
        el.style.left = `${outlet.x * RENDER_SCALE}px`;
        el.style.top = `${outlet.y * RENDER_SCALE}px`;
      }
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      if (moved) {
        this.cb.onGeometryChanged();
      }
      this.select('outlet', outlet.id);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }

  #onRoomDrag(e, room, el, kind) {
    e.stopPropagation();
    if (this.readOnly) {
      this.select('room', room.id);
      return;
    }
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startPage = this.#toPage(e.clientX, e.clientY);
    const orig = { ...room.bounds };
    let moved = false;

    const onMove = (ev) => {
      const cur = this.#toPage(ev.clientX, ev.clientY);
      const dx = cur.x - startPage.x;
      const dy = cur.y - startPage.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      if (kind === 'move') {
        room.bounds.x = orig.x + dx;
        room.bounds.y = orig.y + dy;
      } else {
        // הידית בפינה השמאלית-תחתונה: שינוי רוחב שמאלה וגובה למטה
        room.bounds.x = Math.min(orig.x + dx, orig.x + orig.w - 10);
        room.bounds.w = Math.max(10, orig.w - dx);
        room.bounds.h = Math.max(10, orig.h + dy);
      }
      this.#styleRoom(el, room);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      if (moved) this.cb.onGeometryChanged();
      this.select('room', room.id);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  }

  #pinchDist() {
    const pts = [...this.activePointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
  }

  #normRect(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }
}
