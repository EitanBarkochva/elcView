// ===== האפליקציה הראשית — חיווט מסכים, זרימה ומצב =====

import { OUTLET_KINDS, DEFAULT_HEIGHT_CM, COMMON_ROOM_NAMES } from './config.js';
import { Room, Outlet } from './models.js';
import { PdfService } from './services/pdfService.js';
import { PlanDetector } from './services/detector.js';
import { SymbolDetector } from './services/symbolDetector.js';
import { OcrService } from './services/ocrService.js';
import { SupabaseRepo } from './services/db.js';
import { AiAnalyzer } from './services/aiService.js';
import { ExcelExporter } from './services/excelExporter.js';
import { PlanViewer } from './ui/planViewer.js';
import { TableView } from './ui/tableView.js';
import { InspectionView } from './ui/inspectionView.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.repo = new SupabaseRepo();
    this.ai = new AiAnalyzer(this.repo.client);
    this.pdf = new PdfService();
    this.detector = new PlanDetector();
    this.symbolDetector = new SymbolDetector();
    this.ocr = new OcrService();
    this.exporter = new ExcelExporter();

    // מצב נוכחי
    this.project = null;
    this.rooms = [];
    this.outlets = [];

    this.viewer = new PlanViewer(
      {
        viewport: $('planViewport'),
        world: $('planWorld'),
        canvas: $('planCanvas'),
        overlay: $('planOverlay'),
      },
      {
        onSelectOutlet: (o) => this.showOutletEditor(o),
        onSelectRoom: (r) => this.showRoomEditor(r),
        onAddOutlet: (x, y) => this.addOutlet(x, y),
        onAddRoom: (bounds) => this.addRoom(bounds),
        onNameRoomAt: (x, y, clientX, clientY) => this.nameRoomAt(x, y, clientX, clientY),
        onSetEntrance: (x, y) => this.setRoomEntrance(x, y),
        onGeometryChanged: () => this.reassignRooms(),
      },
    );

    this.tableView = new TableView($('summaryTable'), (outlet, patch) => {
      this.repo.updateOutlet(outlet.id, patch)
        .catch((e) => this.toast('שגיאה בשמירה: ' + e.message, true));
      this.viewer.refreshOutlet(outlet);
      this.updateTableStats();
    });

    this.inspectionView = new InspectionView(
      {
        roomSelect: $('inspectionRoom'),
        video: $('cameraVideo'),
        overlay: $('cameraOverlay'),
        placeholder: $('cameraPlaceholder'),
        toggleBtn: $('cameraToggle'),
        autoToggle: $('autoModeToggle'),
        toleranceWrap: $('toleranceWrap'),
        toleranceInput: $('toleranceInput'),
        measurePanel: $('measurePanel'),
        checklist: $('inspectionChecklist'),
      },
      (outlet, patch) => {
        this.repo.updateOutlet(outlet.id, patch)
          .catch((e) => this.toast('שגיאה בשמירת המדידה: ' + e.message, true));
        this.viewer.refreshOutlet(outlet);
      },
    );

    this.#bindUi();
    this.refreshProjectList();
  }

  // ---------- ניווט ----------

  showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(`screen-${name}`).classList.add('active');
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.screen === name);
    });
    if (name !== 'inspection') this.inspectionView.stopCamera();
    if (name === 'plan') requestAnimationFrame(() => this.viewer.fit());
    if (name === 'table') this.renderTable();
    if (name === 'inspection') this.inspectionView.setData(this.rooms, this.outlets);
  }

  #enableProjectTabs() {
    document.querySelectorAll('.tab').forEach((t) => { t.disabled = false; });
    $('projectTitle').textContent = this.project ? `📋 ${this.project.name}` : '';
  }

  // ---------- מסך פרויקטים ----------

  async refreshProjectList() {
    const wrap = $('projectList');
    try {
      const projects = await this.repo.listProjects();
      wrap.innerHTML = projects.length ? '' : '<p class="muted">אין עדיין פרויקטים.</p>';
      for (const p of projects) {
        const row = document.createElement('div');
        row.className = 'project-row';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.name;
        name.addEventListener('click', () => this.openProject(p));
        const date = document.createElement('span');
        date.className = 'date';
        date.textContent = p.createdAt.toLocaleDateString('he-IL');
        const del = document.createElement('button');
        del.className = 'btn danger';
        del.textContent = 'מחק';
        del.addEventListener('click', async () => {
          if (!confirm(`למחוק את הפרויקט "${p.name}"?`)) return;
          await this.repo.deleteProject(p.id);
          this.refreshProjectList();
        });
        row.append(name, date, del);
        wrap.appendChild(row);
      }
    } catch (e) {
      wrap.innerHTML = `<p class="muted">שגיאה בטעינת הפרויקטים: ${e.message}</p>`;
    }
  }

  async createProject(name, file) {
    this.toast('מעלה את השרטוט...');
    this.project = await this.repo.createProject(name, file);
    const buf = await file.arrayBuffer();
    await this.#loadPlan(buf);

    // זיהוי אוטומטי: טקסט/הערות מה-PDF + זיהוי גיאומטרי של הסמלים,
    // וחיבור ביניהם לפי קרבה פיזית בדף
    this.setStatus('מזהה שקעים, סמלים, חדרים ומרחקים...');
    const textItems = await this.pdf.extractTextItems();
    this.outlets = this.detector.detectOutlets(textItems, this.project.id);
    const symbols = this.symbolDetector.detect($('planCanvas'), textItems);
    const fusion = this.detector.fuseSymbols(this.outlets, symbols);
    this.rooms = this.detector.detectRoomsFromItems(textItems, this.project.id, this.pdf.pageSize);
    const dists = this.detector.suggestDistancesFromItems(textItems, this.outlets);
    this.reassignRooms();
    this.viewer.setData(this.rooms, this.outlets);
    this.setStatus(
      `זוהו ${this.outlets.length} נקודות (${fusion.snapped} עוגנו לסמלים), ` +
      `${this.rooms.length} חדרים, ${dists} מרחקים. ` +
      (this.rooms.length
        ? 'גרור ומתח את מלבני החדרים לגבולות האמיתיים.'
        : 'הרץ OCR לזיהוי חדרים או סמן ידנית.'),
    );

    this.#enableProjectTabs();
    this.showScreen('plan');
    this.toast(`זוהו ${this.outlets.length} נקודות חשמל בשרטוט`);
  }

  async openProject(project) {
    try {
      this.toast('טוען פרויקט...');
      this.project = project;
      const buf = await this.repo.downloadPdf(project.pdfPath);
      await this.#loadPlan(buf);
      this.rooms = await this.repo.loadRooms(project.id);
      this.outlets = await this.repo.loadOutlets(project.id);
      const hasSavedData = this.outlets.length > 0;
      if (!hasSavedData) {
        // פרויקט שטרם אושר — מריצים זיהוי מחדש מהטקסט, ההערות והסמלים
        const textItems = await this.pdf.extractTextItems();
        this.outlets = this.detector.detectOutlets(textItems, project.id);
        const symbols = this.symbolDetector.detect($('planCanvas'), textItems);
        this.detector.fuseSymbols(this.outlets, symbols);
        if (!this.rooms.length) {
          this.rooms = this.detector.detectRoomsFromItems(textItems, project.id, this.pdf.pageSize);
        }
        this.detector.suggestDistancesFromItems(textItems, this.outlets);
        this.detector.assignOutletsToRooms(this.outlets, this.rooms);
      }
      this.viewer.setData(this.rooms, this.outlets);
      this.setStatus(`${this.rooms.length} חדרים, ${this.outlets.length} נקודות`);
      this.#enableProjectTabs();
      // אם כבר יש נתונים שמורים — ישר לטבלה; אחרת למסך הזיהוי
      this.showScreen(hasSavedData ? 'table' : 'plan');
    } catch (e) {
      this.toast('שגיאה בפתיחת הפרויקט: ' + e.message, true);
    }
  }

  async #loadPlan(arrayBuffer) {
    await this.pdf.load(arrayBuffer);
    await this.pdf.renderTo($('planCanvas'));
    const overlay = $('planOverlay');
    overlay.style.width = `${$('planCanvas').width}px`;
    overlay.style.height = `${$('planCanvas').height}px`;
  }

  // ---------- מסך שרטוט: עריכה ----------

  addOutlet(x, y) {
    const outlet = new Outlet({
      project_id: this.project.id,
      x, y,
      height_cm: DEFAULT_HEIGHT_CM,
    });
    const room = this.rooms.find((r) => r.contains(x, y));
    if (room) outlet.roomId = room.id;
    this.outlets.push(outlet);
    this.viewer.renderAll();
    this.viewer.select('outlet', outlet.id);
  }

  addRoom(bounds) {
    const room = new Room({ project_id: this.project.id, bounds });
    this.rooms.push(room);
    this.reassignRooms();
    this.viewer.renderAll();
    this.viewer.select('room', room.id);
    // מיד אחרי מתיחת המלבן — שואלים מה שם החדר
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    this.openRoomNamePopup(room, cx, cy);
  }

  /**
   * מצב "שם חדר": הקשה על השרטוט פותחת חלונית לכתיבת שם החדר —
   * עריכת החדרים בתוך התוכנה בלי צורך בעורך PDF חיצוני.
   * אם ההקשה בתוך חדר קיים — עורכים את שמו; אחרת נוצר חדר חדש סביב הנקודה.
   */
  nameRoomAt(x, y, clientX, clientY) {
    const existing = this.rooms.find((r) => r.contains(x, y));
    if (existing) {
      this.openRoomNamePopup(existing, x, y, clientX, clientY);
      return;
    }
    const w = Math.min(150, this.pdf.pageSize.width / 6);
    const h = Math.min(110, this.pdf.pageSize.height / 6);
    const room = new Room({
      project_id: this.project.id,
      bounds: { x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), w, h },
    });
    this.rooms.push(room);
    this.reassignRooms();
    this.viewer.renderAll();
    this.viewer.select('room', room.id);
    this.openRoomNamePopup(room, x, y, clientX, clientY, true);
  }

  /**
   * חלונית בחירת שם חדר: כפתורי שמות נפוצים + שדה חופשי.
   * @param {Room} room החדר לעדכון
   * @param {boolean} isNew חדר שנוצר עכשיו — ביטול ימחק אותו
   */
  openRoomNamePopup(room, pageX, pageY, clientX = null, clientY = null, isNew = false) {
    const popup = $('roomNamePopup');
    popup.classList.remove('hidden');

    // מיקום ליד ההקשה, מוצמד לגבולות המסך; בלעדיה — במרכז
    if (clientX != null) {
      const pw = 340;
      const ph = 260;
      popup.style.left = `${Math.min(Math.max(8, clientX - pw / 2), innerWidth - pw - 8)}px`;
      popup.style.top = `${Math.min(Math.max(8, clientY + 12), innerHeight - ph - 8)}px`;
    } else {
      popup.style.left = `${(innerWidth - 340) / 2}px`;
      popup.style.top = '25vh';
    }

    const quick = $('quickNames');
    quick.innerHTML = '';
    const apply = (name) => {
      room.name = name.trim();
      this.viewer.refreshRoom(room);
      this.closeRoomNamePopup();
      this.reassignRooms();
    };
    for (const name of COMMON_ROOM_NAMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = name;
      b.addEventListener('click', () => apply(name));
      quick.appendChild(b);
    }

    const input = $('customRoomName');
    input.value = room.name === 'חדר' ? '' : room.name;
    const confirm = $('confirmRoomName');
    const cancel = $('cancelRoomName');
    confirm.onclick = () => { if (input.value.trim()) apply(input.value); };
    input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) apply(input.value); };
    cancel.onclick = () => {
      if (isNew) {
        // ביטול על חדר חדש — מסירים אותו
        this.rooms = this.rooms.filter((r) => r.id !== room.id);
        this.viewer.rooms = this.rooms;
        this.viewer.removeElement('room', room.id);
      }
      this.closeRoomNamePopup();
    };
    setTimeout(() => input.focus(), 50);
  }

  closeRoomNamePopup() {
    $('roomNamePopup').classList.add('hidden');
  }

  reassignRooms() {
    this.detector.assignOutletsToRooms(this.outlets, this.rooms);
  }

  /**
   * סימון פתח החלל: אחרי לחיצה על "סמן פתח" בעורך החדר, ההקשה הבאה
   * על השרטוט קובעת מאיפה מתחיל המספור של המוצרים בחלל.
   */
  setRoomEntrance(x, y) {
    const room = this._entranceRoom;
    this._entranceRoom = null;
    this.viewer.setMode('pan');
    this.#setToolButtons('modePan');
    if (!room) return;
    room.entrance = { x, y };
    this.detector.numberOutlets(this.outlets, this.rooms);
    this.viewer.renderAll();
    this.setStatus(`סומן פתח לחלל "${room.name}" — המספור עודכן.`);
  }

  async runOcr() {
    const btn = $('runOcr');
    btn.disabled = true;
    try {
      // מעבר 1: שמות חדרים (עברית)
      this.setStatus('מריץ OCR לזיהוי שמות חדרים... 0%');
      const words = await this.ocr.recognizeRoomNames($('planCanvas'), (p) => {
        this.setStatus(`מריץ OCR לזיהוי שמות חדרים... ${Math.round(p * 100)}%`);
      });
      const suggestions = this.detector.suggestRooms(words, this.project.id, this.pdf.pageSize);
      // מוסיפים רק חדרים חדשים שלא חופפים לקיימים
      let added = 0;
      for (const s of suggestions) {
        const overlap = this.rooms.some(
          (r) => r.bounds && Math.hypot(
            r.bounds.x - s.bounds.x, r.bounds.y - s.bounds.y,
          ) < 60,
        );
        if (!overlap) { this.rooms.push(s); added++; }
      }
      this.reassignRooms();

      // מעבר 2: מספרי קווי המידה (ספרות) ⇒ הצעת מרחק מקיר סמוך
      this.setStatus('מריץ OCR לזיהוי מרחקים... 0%');
      const numbers = await this.ocr.recognizeNumbers($('planCanvas'), (p) => {
        this.setStatus(`מריץ OCR לזיהוי מרחקים... ${Math.round(p * 100)}%`);
      });
      const filled = this.detector.suggestDistances(numbers, this.outlets);

      this.viewer.renderAll();
      this.setStatus(
        `OCR: ${added} חדרים חדשים, ${filled} הצעות מרחק. ` +
        'גרור ומתח את מלבני החדרים ובדוק את המרחקים שהוצעו.',
      );
    } catch (e) {
      this.setStatus('שגיאת OCR: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * ניתוח AI: שולח את השרטוט ל-Claude ומקבל חדרים ונקודות מפוענחים.
   * החדרים מוחלפים בתוצאת הניתוח; הנקודות ממוזגות — נקודה קיימת קרובה
   * מתעדכנת (כמות, מרחק, מעגל), ונקודות חדשות נוספות.
   */
  async runAiAnalysis() {
    const btn = $('runAi');
    btn.disabled = true;
    try {
      this.setStatus('🤖 שולח את השרטוט לניתוח Claude... זה יכול לקחת דקה-שתיים');
      const items = await this.pdf.extractTextItems();
      const analysis = await this.ai.analyze($('planCanvas'), items, this.pdf.pageSize);
      const summary = this.#applyAiAnalysis(analysis);
      this.setStatus(
        `🤖 Claude: ${summary.rooms} חדרים, עודכנו ${summary.updated} נקודות, ` +
        `נוספו ${summary.added}. ${analysis.notes || ''}`,
      );
      this.toast('ניתוח Claude הושלם — בדוק את התוצאות על השרטוט');
    } catch (e) {
      this.setStatus('שגיאת ניתוח Claude: ' + e.message);
      this.toast('שגיאת ניתוח Claude', true);
    } finally {
      btn.disabled = false;
    }
  }

  #applyAiAnalysis(analysis) {
    // חדרים: תוצאת הניתוח מחליפה את ההצעות הקיימות
    if (analysis.rooms?.length) {
      this.rooms = analysis.rooms.map((r) => new Room({
        project_id: this.project.id,
        name: r.name,
        bounds: {
          x: Math.min(r.x0, r.x1),
          y: Math.min(r.y0, r.y1),
          w: Math.abs(r.x1 - r.x0),
          h: Math.abs(r.y1 - r.y0),
        },
      }));
    }

    // נקודות: מיזוג לפי קרבה גיאומטרית
    let updated = 0;
    let added = 0;
    const aiRoomOf = new Map(); // outlet.id ⇒ שם החדר לפי Claude
    for (const ao of analysis.outlets ?? []) {
      let outlet = null;
      let best = 20; // רדיוס התאמה בנקודות עמוד
      for (const o of this.outlets) {
        const d = Math.hypot(o.x - ao.x, o.y - ao.y);
        if (d < best) { best = d; outlet = o; }
      }
      if (outlet) {
        outlet.kind = ao.kind || outlet.kind;
        if (outlet.heightCm == null && ao.height_cm != null) outlet.heightCm = ao.height_cm;
        if (ao.quantity >= 1) outlet.quantity = Math.min(4, ao.quantity);
        if (ao.corner_distance_cm != null) outlet.cornerDistanceCm = ao.corner_distance_cm;
        if (ao.circuit) outlet.circuit = ao.circuit;
        updated++;
      } else {
        outlet = new Outlet({
          project_id: this.project.id,
          x: ao.x,
          y: ao.y,
          kind: ao.kind || 'שקע',
          height_cm: ao.height_cm,
          corner_distance_cm: ao.corner_distance_cm,
          circuit: ao.circuit,
          quantity: Math.min(4, Math.max(1, ao.quantity || 1)),
        });
        this.outlets.push(outlet);
        added++;
      }
      if (ao.room) aiRoomOf.set(outlet.id, ao.room);
    }

    // שיוך לחדרים: קודם לפי הכלה גיאומטרית, ואז לפי השם ש-Claude נתן
    this.reassignRooms();
    for (const o of this.outlets) {
      if (o.roomId) continue;
      const name = aiRoomOf.get(o.id);
      if (!name) continue;
      const room = this.rooms.find((r) => r.name === name);
      if (room) o.roomId = room.id;
    }

    this.viewer.setData(this.rooms, this.outlets);
    return { rooms: this.rooms.length, updated, added };
  }

  async confirmPlan() {
    if (!this.outlets.length) {
      this.toast('אין נקודות לשמירה — הוסף שקעים על השרטוט', true);
      return;
    }
    try {
      this.reassignRooms();
      // מזהה לכל מוצר: שם חלל + מספר רץ מהפתח (מטבח-1, מטבח-2...)
      this.detector.numberOutlets(this.outlets, this.rooms);
      this.setStatus('שומר...');
      await this.repo.saveDetection(this.project.id, this.rooms, this.outlets);
      this.setStatus('נשמר ✓');
      this.toast('הנתונים נשמרו');
      this.showScreen('table');
    } catch (e) {
      this.toast('שגיאה בשמירה: ' + e.message, true);
      this.setStatus('');
    }
  }

  // ---------- פאנל עריכה צדדי ----------

  showOutletEditor(outlet) {
    const panel = $('editorPanel');
    if (!outlet) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = '<h3>עריכת נקודה</h3>';

    const kindSel = this.#labeled(panel, 'סוג נקודה', 'select');
    const kinds = OUTLET_KINDS.includes(outlet.kind)
      ? OUTLET_KINDS
      : [outlet.kind, ...OUTLET_KINDS]; // מוצרים מהמקרא (דוד, מזגן...)
    for (const k of kinds) {
      kindSel.add(new Option(k, k, false, k === outlet.kind));
    }
    kindSel.addEventListener('change', () => {
      outlet.kind = kindSel.value;
      this.viewer.refreshOutlet(outlet);
    });

    // כמות שקעים בנקודה: בודד / כפול / משולש / רביעייה
    const qtyLabel = document.createElement('label');
    qtyLabel.textContent = 'כמות שקעים בנקודה';
    const qtyRow = document.createElement('div');
    qtyRow.className = 'qty-row';
    const qtyBtns = [];
    for (const q of [1, 2, 3, 4]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn qty' + (outlet.quantity === q ? ' tap-active' : '');
      b.textContent = q;
      b.addEventListener('click', () => {
        outlet.quantity = q;
        for (const other of qtyBtns) other.classList.toggle('tap-active', other === b);
        this.viewer.refreshOutlet(outlet);
      });
      qtyBtns.push(b);
      qtyRow.appendChild(b);
    }
    qtyLabel.appendChild(qtyRow);
    panel.appendChild(qtyLabel);

    const height = this.#labeled(panel, 'גובה מהרצפה (ס"מ)', 'input');
    height.type = 'number';
    height.value = outlet.heightCm ?? '';
    height.addEventListener('input', () => {
      outlet.heightCm = height.value === '' ? null : parseInt(height.value, 10);
      this.viewer.refreshOutlet(outlet);
    });

    const dist = this.#labeled(panel, 'מרחק מקיר סמוך (ס"מ) — קו המידה בשרטוט', 'input');
    dist.type = 'number';
    dist.value = outlet.cornerDistanceCm ?? '';
    dist.addEventListener('input', () => {
      outlet.cornerDistanceCm = dist.value === '' ? null : parseInt(dist.value, 10);
    });

    const circuit = this.#labeled(panel, 'מעגל', 'input');
    circuit.value = outlet.circuit ?? '';
    circuit.addEventListener('input', () => {
      outlet.circuit = circuit.value || null;
    });

    const roomSel = this.#labeled(panel, 'חדר', 'select');
    roomSel.add(new Option('— ללא חדר —', ''));
    for (const r of this.rooms) {
      roomSel.add(new Option(r.name, r.id, false, r.id === outlet.roomId));
    }
    roomSel.addEventListener('change', () => {
      outlet.roomId = roomSel.value || null;
    });

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = 'מחק נקודה';
    del.addEventListener('click', () => {
      this.outlets = this.outlets.filter((o) => o.id !== outlet.id);
      this.viewer.outlets = this.outlets;
      this.viewer.removeElement('outlet', outlet.id);
      panel.classList.add('hidden');
    });
    actions.appendChild(del);
    panel.appendChild(actions);
  }

  showRoomEditor(room) {
    const panel = $('editorPanel');
    if (!room) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = '<h3>עריכת חדר</h3>';

    const doorBtn = document.createElement('button');
    doorBtn.className = 'btn';
    doorBtn.style.marginBottom = '8px';
    doorBtn.textContent = room.entrance ? '🚪 הזז את הפתח' : '🚪 סמן פתח (תחילת המספור)';
    doorBtn.addEventListener('click', () => {
      this._entranceRoom = room;
      this.viewer.setMode('setEntrance');
      this.setStatus(`הקש על השרטוט במיקום הפתח של "${room.name}"`);
    });
    panel.appendChild(doorBtn);

    const name = this.#labeled(panel, 'שם החדר', 'input');
    name.setAttribute('list', 'roomNamesList');
    let dl = $('roomNamesList');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'roomNamesList';
      document.body.appendChild(dl);
      for (const n of COMMON_ROOM_NAMES) dl.appendChild(new Option(n, n));
    }
    name.value = room.name;
    name.addEventListener('input', () => {
      room.name = name.value;
      this.viewer.refreshRoom(room);
    });

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = 'מחק חדר';
    del.addEventListener('click', () => {
      this.rooms = this.rooms.filter((r) => r.id !== room.id);
      for (const o of this.outlets) {
        if (o.roomId === room.id) o.roomId = null;
      }
      this.viewer.rooms = this.rooms;
      this.viewer.removeElement('room', room.id);
      panel.classList.add('hidden');
    });
    actions.appendChild(del);
    panel.appendChild(actions);
  }

  #labeled(panel, text, tag) {
    const label = document.createElement('label');
    label.textContent = text;
    const el = document.createElement(tag);
    label.appendChild(el);
    panel.appendChild(label);
    return el;
  }

  // ---------- טבלה ----------

  renderTable() {
    this.tableView.render(this.rooms, this.outlets);
    this.updateTableStats();
  }

  updateTableStats() {
    const done = this.outlets.filter((o) => o.done).length;
    $('tableStats').textContent =
      `${this.outlets.length} נקודות ב-${this.rooms.length} חדרים · בוצעו ${done}`;
  }

  // ---------- עזר ----------

  setStatus(text) {
    $('detectStatus').textContent = text;
  }

  toast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast${isError ? ' error' : ''}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  #setToolButtons(activeId) {
    for (const id of ['modePan', 'modeAddOutlet', 'modeAddRoom', 'modeNameRoom']) {
      $(id).classList.toggle('active', id === activeId);
    }
  }

  // ---------- חיווט ----------

  #bindUi() {
    // טאבים
    $('mainTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (btn && !btn.disabled) this.showScreen(btn.dataset.screen);
    });

    // טופס פרויקט חדש
    $('pdfFile').addEventListener('change', () => {
      $('pdfFileName').textContent = $('pdfFile').files[0]?.name || '';
    });
    $('newProjectForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = $('pdfFile').files[0];
      if (!file) return;
      try {
        await this.createProject($('projectName').value.trim(), file);
        $('newProjectForm').reset();
        $('pdfFileName').textContent = '';
        this.refreshProjectList();
      } catch (err) {
        this.toast('שגיאה ביצירת הפרויקט: ' + err.message, true);
      }
    });

    // סרגל כלים של השרטוט
    $('modePan').addEventListener('click', () => {
      this.viewer.setMode('pan'); this.#setToolButtons('modePan');
    });
    $('modeAddOutlet').addEventListener('click', () => {
      this.viewer.setMode('addOutlet'); this.#setToolButtons('modeAddOutlet');
    });
    $('modeAddRoom').addEventListener('click', () => {
      this.viewer.setMode('addRoom'); this.#setToolButtons('modeAddRoom');
    });
    $('modeNameRoom').addEventListener('click', () => {
      this.viewer.setMode('nameRoom'); this.#setToolButtons('modeNameRoom');
    });
    $('zoomIn').addEventListener('click', () => this.viewer.zoomBy(1.25));
    $('zoomOut').addEventListener('click', () => this.viewer.zoomBy(1 / 1.25));
    $('zoomFit').addEventListener('click', () => this.viewer.fit());
    $('runAi').addEventListener('click', () => this.runAiAnalysis());
    $('runOcr').addEventListener('click', () => this.runOcr());
    $('confirmPlan').addEventListener('click', () => this.confirmPlan());

    // טבלה
    $('exportExcel').addEventListener('click', () => {
      this.exporter.export(this.project?.name, this.rooms, this.outlets);
    });
    $('backToPlan').addEventListener('click', () => this.showScreen('plan'));
  }
}

window.app = new App();
