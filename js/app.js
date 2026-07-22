// ===== האפליקציה הראשית — חיווט מסכים, זרימה ומצב =====

import {
  OUTLET_KINDS, DEFAULT_HEIGHT_CM, COMMON_ROOM_NAMES, ROLE_NAMES, PRODUCT_LEXICON,
} from './config.js';
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
import { SchematicView, kindColor } from './ui/schematicView.js';
import { InspectionView } from './ui/inspectionView.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.repo = new SupabaseRepo();
    this.ai = new AiAnalyzer(this.repo.client);
    this.pdf = new PdfService();
    this.detector = new PlanDetector();
    this.symbolDetector = new SymbolDetector();
    this.schematicView = new SchematicView();

    // מציג אינטראקטיבי שני לכרטיסיית "שרטוט חשמלי": רקע נקי, סיכות עם
    // המזהה (מטבח-1) בצבע לפי סוג, בלי מלבני חדרים
    this.schemViewer = new PlanViewer(
      {
        viewport: $('schemViewport'),
        world: $('schemWorld'),
        canvas: $('schemCanvas'),
        overlay: $('schemOverlay'),
      },
      {
        onSelectOutlet: (o) => this.#schemSelect(o),
        onSelectRoom: () => {},
        onAddOutlet: (x, y) => this.#schemAddOutlet(x, y),
        onAddRoom: () => {},
        onNameRoomAt: () => {},
        onSetEntrance: () => {},
        onGeometryChanged: () => {
          this.reassignRooms();
          this.detector.numberOutlets(this.outlets, this.rooms);
          this.schemViewer.renderAll();
        },
      },
      {
        pinText: (o) => o.label || o.kind,
        pinColor: (o) => kindColor(o.kind),
        showRooms: false,
      },
    );
    this._paletteKind = null; // הרכיב שנבחר במקרא להוספה

    // מציג שלישי לכרטיסיית "עריכה": רקע = העתק מדויק 1:1 של ה-PDF
    // (בלי עיבוד), אלמנטים חשמליים בולטים, עריכה מלאה (גרירה/הוספה/מחיקה)
    this.editViewer = new PlanViewer(
      {
        viewport: $('editViewport'),
        world: $('editWorld'),
        canvas: $('editCanvas'),
        overlay: $('editOverlay'),
      },
      {
        onSelectOutlet: (o) => this.#editSelect(o),
        onSelectRoom: () => {},
        onAddOutlet: (x, y) => this.#editAddOutlet(x, y),
        onAddRoom: () => {},
        onNameRoomAt: () => {},
        onSetEntrance: () => {},
        onGeometryChanged: () => {
          this.reassignRooms();
          this.detector.numberOutlets(this.outlets, this.rooms);
          this.editViewer.renderAll();
        },
      },
      {
        pinText: (o) => o.label || o.kind,
        pinColor: (o) => kindColor(o.kind),
        showRooms: false,
      },
    );
    this._editPaletteKind = null;
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

    this.profile = null; // הפרופיל (כולל תפקיד) של המשתמש המחובר
    this.#bindUi();
    this.#initAuth();
  }

  // ---------- אימות ותפקידים ----------

  get isEditor() {
    return ['admin', 'contractor', 'architect'].includes(this.profile?.role);
  }

  async #initAuth() {
    try {
      const session = await this.repo.getSession();
      if (session) await this.#onLoggedIn();
      else this.#showLogin();
    } catch {
      this.#showLogin();
    }
  }

  #showLogin() {
    this.profile = null;
    $('mainTabs').classList.add('hidden');
    $('userArea').classList.add('hidden');
    this.showScreen('login');
  }

  async #onLoggedIn() {
    this.profile = await this.repo.getMyProfile();
    if (!this.profile) {
      this.#showLogin();
      return;
    }
    $('mainTabs').classList.remove('hidden');
    $('userArea').classList.remove('hidden');
    $('userInfo').textContent =
      `${this.profile.name || this.profile.email} · ${ROLE_NAMES[this.profile.role] || this.profile.role}`;
    this.#applyRoleUi();
    this.showScreen('projects');
    this.refreshProjectList();
    if (this.profile.role === 'admin') this.#renderUsersPanel();
  }

  /** התאמת הממשק לתפקיד המשתמש */
  #applyRoleUi() {
    const role = this.profile.role;
    // שרטוט: עורכים בלבד; ביקורת: כולם חוץ מלקוח
    document.querySelector('[data-screen="plan"]').classList.toggle('hidden', !this.isEditor);
    // עריכה: עורכים בלבד (מנהל/קבלן/אדריכל)
    document.querySelector('[data-screen="edit"]').classList.toggle('hidden', !this.isEditor);
    document.querySelector('[data-screen="inspection"]').classList.toggle('hidden', role === 'client');
    // יצירת פרויקטים: עורכים בלבד
    $('newProjectPanel').classList.toggle('hidden', !this.isEditor);
    $('usersPanel').classList.toggle('hidden', role !== 'admin');
    // כפתורי טבלה
    $('approveProject').classList.toggle('hidden', !this.isEditor);
    $('saveSchematic').classList.toggle('hidden', !this.isEditor);
    $('newRequest').classList.toggle('hidden', !(role === 'client' || role === 'admin'));
    $('backToPlan').classList.toggle('hidden', !this.isEditor);
  }

  /** פאנל ניהול משתמשים — מנהל מערכת בלבד */
  async #renderUsersPanel() {
    const wrap = $('usersList');
    try {
      const profiles = await this.repo.listProfiles();
      wrap.innerHTML = '';
      for (const p of profiles) {
        const row = document.createElement('div');
        row.className = 'project-row';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.name ? `${p.name} (${p.email})` : p.email;
        const roleSel = document.createElement('select');
        for (const [value, label] of Object.entries(ROLE_NAMES)) {
          roleSel.add(new Option(label, value, false, p.role === value));
        }
        roleSel.addEventListener('change', async () => {
          try {
            await this.repo.setRole(p.id, roleSel.value);
            this.toast(`התפקיד של ${p.email} עודכן ל${ROLE_NAMES[roleSel.value]}`);
          } catch (e) {
            this.toast('שגיאה בעדכון תפקיד: ' + e.message, true);
          }
        });
        row.append(name, roleSel);
        wrap.appendChild(row);
      }
    } catch (e) {
      wrap.innerHTML = `<p class="muted">שגיאה: ${e.message}</p>`;
    }
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
    if (name === 'table') {
      this.renderTable();
      this.refreshRequests();
      this.refreshComments();
      this.#updateApprovedBadge();
    }
    if (name === 'schematic') this.renderSchematic();
    if (name === 'edit') this.renderEdit();
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
      // אם כבר יש נתונים שמורים — ישר לטבלה; אחרת למסך הזיהוי.
      // מי שאינו עורך תמיד מגיע לטבלה (מסך השרטוט נסתר עבורו).
      this.showScreen(hasSavedData || !this.isEditor ? 'table' : 'plan');
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

  async confirmPlan(goToTable = true) {
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
      if (goToTable) {
        this.showScreen('table');
      } else {
        // שמירה מתוך שרטוט חשמלי / עריכה — נשארים במסך ומרעננים
        this.schemViewer.renderAll();
        this.editViewer.renderAll();
      }
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
    // לקוח רואה את הטבלה לקריאה בלבד
    this.tableView.render(this.rooms, this.outlets, this.profile?.role === 'client');
    this.updateTableStats();
  }

  /** כרטיסיית שרטוט חשמלי: רקע נקי + סיכות אינטראקטיביות + מקרא-פלטה */
  async renderSchematic() {
    if (!this.project || !$('planCanvas').width) return;
    this.setStatus('');
    // מוודאים שלכל אביזר יש מזהה (חלל-מספר)
    if (this.outlets.some((o) => o.roomId && !o.label)) {
      this.detector.numberOutlets(this.outlets, this.rooms);
    }
    // הרקע הנקי נבנה פעם אחת לכל פרויקט (חילוץ הקירות כבד)
    if (this._schemBgFor !== this.project.id) {
      $('schemHint').textContent = 'בונה שרטוט נקי...';
      let textItems = [];
      try { textItems = await this.pdf.extractTextItems(); } catch { /* בלי מחיקה */ }
      this._schemBg = this.schematicView.buildBackground($('planCanvas'), this.rooms, textItems);
      this._schemBgFor = this.project.id;
    }
    const canvas = $('schemCanvas');
    canvas.width = this._schemBg.width;
    canvas.height = this._schemBg.height;
    canvas.getContext('2d').drawImage(this._schemBg, 0, 0);
    const overlay = $('schemOverlay');
    overlay.style.width = `${canvas.width}px`;
    overlay.style.height = `${canvas.height}px`;

    this.schemViewer.readOnly = !this.isEditor;
    this.schemViewer.setData(this.rooms, this.outlets);
    requestAnimationFrame(() => this.schemViewer.fit());
    this.#renderPalette();
    $('schemHint').textContent = this.isEditor
      ? 'בחר רכיב במקרא והקש על השרטוט להוספה; גרור סיכות לדיוק המיקום.'
      : 'הבית עם אביזרי החשמל בלבד. המקרא מימין.';
  }

  /** המקרא בצד ימין: כל סוגי הרכיבים + כמות; לעורכים — לחיצה בוחרת להוספה */
  #renderPalette() {
    const wrap = $('paletteItems');
    wrap.innerHTML = '';
    const counts = new Map();
    for (const o of this.outlets) {
      counts.set(o.kind, (counts.get(o.kind) || 0) + (o.quantity || 1));
    }
    const kinds = [...new Set([...OUTLET_KINDS, ...PRODUCT_LEXICON, ...counts.keys()])];
    for (const kind of kinds) {
      const item = document.createElement('div');
      item.className = 'palette-item' + (this.isEditor ? ' clickable' : '');
      if (this._paletteKind === kind) item.classList.add('active');
      item.innerHTML =
        `<span class="dot" style="background:${kindColor(kind)}"></span>` +
        `<span>${kind}</span>` +
        `<span class="count">${counts.get(kind) || ''}</span>`;
      if (this.isEditor) {
        item.addEventListener('click', () => {
          this._paletteKind = this._paletteKind === kind ? null : kind;
          this.schemViewer.setMode(this._paletteKind ? 'addOutlet' : 'pan');
          this.#renderPalette();
          $('schemHint').textContent = this._paletteKind
            ? `הקש על השרטוט כדי להוסיף ${this._paletteKind} (לחיצה נוספת במקרא מבטלת)`
            : 'גרור רכיב מהמקרא אל השרטוט, או בחר רכיב והקש.';
        });
        // גרירה-ושחרור: גוררים את הרכיב מהמקרא ישירות אל השרטוט
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', kind);
          e.dataTransfer.effectAllowed = 'copy';
        });
      }
      wrap.appendChild(item);
    }
  }

  /** הוספת רכיב מהמקרא — בהקשה (רכיב נבחר) או בגרירה-ושחרור (kind מפורש) */
  #schemAddOutlet(x, y, kind = this._paletteKind) {
    if (!this.isEditor || !kind) return;
    const outlet = new Outlet({
      project_id: this.project.id,
      x, y,
      kind,
      height_cm: kind === 'שקע' ? DEFAULT_HEIGHT_CM : null,
    });
    const room = this.rooms.find((r) => r.contains(x, y));
    if (room) outlet.roomId = room.id;
    this.outlets.push(outlet);
    this.detector.numberOutlets(this.outlets, this.rooms);
    this.schemViewer.setData(this.rooms, this.outlets);
    this.viewer.setData(this.rooms, this.outlets);
    this.#renderPalette();
    this.toast(`נוסף ${kind}${outlet.label ? ` (${outlet.label})` : ''} — זכור לשמור`);
  }

  /** בחירת אביזר בשרטוט הנקי — מציגה כפתור מחיקה לעורכים */
  #schemSelect(outlet) {
    this._schemSelected = outlet;
    const btn = $('deleteSchemOutlet');
    if (outlet && this.isEditor) {
      btn.textContent = `🗑 מחק ${outlet.label || outlet.kind}`;
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  }

  #schemDeleteSelected() {
    const outlet = this._schemSelected;
    if (!outlet || !this.isEditor) return;
    this.outlets = this.outlets.filter((o) => o.id !== outlet.id);
    this.detector.numberOutlets(this.outlets, this.rooms);
    this.schemViewer.setData(this.rooms, this.outlets);
    this.viewer.setData(this.rooms, this.outlets);
    this.#schemSelect(null);
    this.#renderPalette();
    this.toast(`${outlet.label || outlet.kind} נמחק — זכור לשמור`);
  }

  /** הורדת התמונה הסטטית המלאה (בית + אביזרים + מקרא בתחתית) */
  async #downloadSchematic() {
    let textItems = [];
    try { textItems = await this.pdf.extractTextItems(); } catch { /* בלי מחיקה */ }
    const full = this.schematicView.build($('planCanvas'), this.rooms, this.outlets, textItems);
    full.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.project?.name || 'elcView'} - שרטוט חשמלי.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  }

  /** כרטיסיית עריכה: העתק מדויק 1:1 של ה-PDF + אלמנטים חשמליים ניתנים לעריכה */
  renderEdit() {
    if (!this.project || !$('planCanvas').width) return;
    if (this.outlets.some((o) => o.roomId && !o.label)) {
      this.detector.numberOutlets(this.outlets, this.rooms);
    }
    // הרקע = העתק מדויק של רינדור ה-PDF (בלי כל עיבוד — "אחד לאחד")
    const src = $('planCanvas');
    const canvas = $('editCanvas');
    canvas.width = src.width;
    canvas.height = src.height;
    canvas.getContext('2d').drawImage(src, 0, 0);
    const overlay = $('editOverlay');
    overlay.style.width = `${canvas.width}px`;
    overlay.style.height = `${canvas.height}px`;

    this.editViewer.readOnly = !this.isEditor;
    this.editViewer.setData(this.rooms, this.outlets);
    requestAnimationFrame(() => this.editViewer.fit());
    this.#renderEditPalette();
    $('saveEdit').classList.toggle('hidden', !this.isEditor);
    $('editHint').textContent = this.isEditor
      ? 'העתק מדויק של השרטוט. גרור רכיב מהמקרא להוספה, גרור סיכה להזזה, בחר סיכה למחיקה.'
      : 'העתק מדויק של השרטוט עם האלמנטים החשמליים (תצוגה בלבד).';
  }

  #renderEditPalette() {
    const wrap = $('editPaletteItems');
    wrap.innerHTML = '';
    const counts = new Map();
    for (const o of this.outlets) {
      counts.set(o.kind, (counts.get(o.kind) || 0) + (o.quantity || 1));
    }
    const kinds = [...new Set([...OUTLET_KINDS, ...PRODUCT_LEXICON, ...counts.keys()])];
    for (const kind of kinds) {
      const item = document.createElement('div');
      item.className = 'palette-item' + (this.isEditor ? ' clickable' : '');
      if (this._editPaletteKind === kind) item.classList.add('active');
      item.innerHTML =
        `<span class="dot" style="background:${kindColor(kind)}"></span>` +
        `<span>${kind}</span>` +
        `<span class="count">${counts.get(kind) || ''}</span>`;
      if (this.isEditor) {
        item.addEventListener('click', () => {
          this._editPaletteKind = this._editPaletteKind === kind ? null : kind;
          this.editViewer.setMode(this._editPaletteKind ? 'addOutlet' : 'pan');
          this.#renderEditPalette();
        });
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', kind);
          e.dataTransfer.effectAllowed = 'copy';
        });
      }
      wrap.appendChild(item);
    }
  }

  #editAddOutlet(x, y, kind = this._editPaletteKind) {
    if (!this.isEditor || !kind) return;
    const outlet = new Outlet({
      project_id: this.project.id, x, y, kind,
      height_cm: kind === 'שקע' ? DEFAULT_HEIGHT_CM : null,
    });
    const room = this.rooms.find((r) => r.contains(x, y));
    if (room) outlet.roomId = room.id;
    this.outlets.push(outlet);
    this.detector.numberOutlets(this.outlets, this.rooms);
    this.editViewer.setData(this.rooms, this.outlets);
    this.viewer.setData(this.rooms, this.outlets);
    this.#renderEditPalette();
    this.toast(`נוסף ${kind}${outlet.label ? ` (${outlet.label})` : ''} — זכור לשמור`);
  }

  #editSelect(outlet) {
    this._editSelected = outlet;
    const btn = $('deleteEditOutlet');
    if (outlet && this.isEditor) {
      btn.textContent = `🗑 מחק ${outlet.label || outlet.kind}`;
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  }

  #editDeleteSelected() {
    const outlet = this._editSelected;
    if (!outlet || !this.isEditor) return;
    this.outlets = this.outlets.filter((o) => o.id !== outlet.id);
    this.detector.numberOutlets(this.outlets, this.rooms);
    this.editViewer.setData(this.rooms, this.outlets);
    this.viewer.setData(this.rooms, this.outlets);
    this.#editSelect(null);
    this.#renderEditPalette();
    this.toast(`${outlet.label || outlet.kind} נמחק — זכור לשמור`);
  }

  #updateApprovedBadge() {
    const badge = $('approvedBadge');
    if (this.project?.approvedAt) {
      badge.textContent =
        `✔ התוכנית אושרה ע"י ${this.project.approvedBy} · ${this.project.approvedAt.toLocaleDateString('he-IL')}`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ---------- בקשות שינוי ----------

  async refreshRequests() {
    if (!this.project) return;
    const wrap = $('requestList');
    try {
      const requests = await this.repo.listRequests(this.project.id);
      wrap.innerHTML = requests.length ? '' : '<p class="muted">אין בקשות.</p>';
      const statusText = {
        pending: 'ממתין לתמחור הקבלן',
        priced: 'ממתין לאישור הלקוח',
        approved: 'אושר ונוסף לטבלה',
        rejected: 'נדחה',
      };
      for (const r of requests) {
        const div = document.createElement('div');
        div.className = 'request-item';
        div.innerHTML =
          `<b>${r.kind}</b> בחדר <b>${r.room_name}</b>` +
          (r.height_cm != null ? ` · גובה ${r.height_cm} ס"מ` : '') +
          (r.corner_distance_cm != null ? ` · מרחק ${r.corner_distance_cm} ס"מ` : '') +
          (r.notes ? ` · ${r.notes}` : '') +
          `<br><span class="req-status ${r.status}">${statusText[r.status]}</span>` +
          (r.price != null ? ` · מחיר: <b>${r.price} ₪</b>` : '') +
          ` <span class="muted small">(${r.created_by_email || ''})</span>`;

        const actions = document.createElement('div');
        actions.className = 'req-actions';

        // קבלן/אדריכל/מנהל: תמחור בקשה ממתינה, דחייה
        if (this.isEditor && r.status === 'pending') {
          const priceInput = document.createElement('input');
          priceInput.type = 'number';
          priceInput.placeholder = 'מחיר ₪';
          const priceBtn = document.createElement('button');
          priceBtn.className = 'btn primary';
          priceBtn.textContent = 'תמחר';
          priceBtn.addEventListener('click', async () => {
            const price = parseFloat(priceInput.value);
            if (!(price >= 0)) return this.toast('הזן מחיר', true);
            await this.#safeRequestUpdate(r.id, { price, status: 'priced' });
          });
          actions.append(priceInput, priceBtn);
        }
        if (this.isEditor && ['pending', 'priced'].includes(r.status)) {
          const rejectBtn = document.createElement('button');
          rejectBtn.className = 'btn danger';
          rejectBtn.textContent = 'דחה';
          rejectBtn.addEventListener('click', () =>
            this.#safeRequestUpdate(r.id, { status: 'rejected' }));
          actions.appendChild(rejectBtn);
        }
        // הלקוח שיצר: אישור/דחייה של המחיר
        if (r.created_by === this.profile.id && r.status === 'priced') {
          const okBtn = document.createElement('button');
          okBtn.className = 'btn primary';
          okBtn.textContent = `✔ מאשר את המחיר (${r.price} ₪)`;
          okBtn.addEventListener('click', () =>
            this.#safeRequestUpdate(r.id, { status: 'approved' }, true));
          const noBtn = document.createElement('button');
          noBtn.className = 'btn';
          noBtn.textContent = 'לא מאשר';
          noBtn.addEventListener('click', () =>
            this.#safeRequestUpdate(r.id, { status: 'rejected' }));
          actions.append(okBtn, noBtn);
        }

        if (actions.children.length) div.appendChild(actions);
        wrap.appendChild(div);
      }
    } catch (e) {
      wrap.innerHTML = `<p class="muted">שגיאה: ${e.message}</p>`;
    }
  }

  async #safeRequestUpdate(id, patch, reloadOutlets = false) {
    try {
      await this.repo.updateRequest(id, patch);
      if (reloadOutlets) {
        // הבקשה אושרה — האביזר נוסף לטבלה בצד השרת; טוענים מחדש
        this.outlets = await this.repo.loadOutlets(this.project.id);
        this.viewer.setData(this.rooms, this.outlets);
        this.renderTable();
        this.toast('הבקשה אושרה — האביזר נוסף לטבלה');
      }
      this.refreshRequests();
    } catch (e) {
      this.toast('שגיאה: ' + e.message, true);
    }
  }

  #openRequestPopup() {
    const popup = $('requestPopup');
    popup.classList.remove('hidden');
    popup.style.left = `${Math.max(8, (innerWidth - 340) / 2)}px`;
    popup.style.top = '15vh';
    const roomSel = $('reqRoom');
    roomSel.innerHTML = '';
    const names = [...new Set(this.rooms.map((r) => r.name))];
    for (const n of names) roomSel.add(new Option(n, n));
    const kindSel = $('reqKind');
    kindSel.innerHTML = '';
    for (const k of [...OUTLET_KINDS, ...PRODUCT_LEXICON]) kindSel.add(new Option(k, k));
  }

  async #sendRequest() {
    try {
      await this.repo.createRequest({
        project_id: this.project.id,
        room_name: $('reqRoom').value,
        kind: $('reqKind').value,
        height_cm: $('reqHeight').value ? parseInt($('reqHeight').value, 10) : null,
        corner_distance_cm: $('reqDist').value ? parseInt($('reqDist').value, 10) : null,
        notes: $('reqNotes').value || '',
        created_by: this.profile.id,
        created_by_email: this.profile.email,
      });
      $('requestPopup').classList.add('hidden');
      this.toast('הבקשה נשלחה לקבלן לתמחור');
      this.refreshRequests();
    } catch (e) {
      this.toast('שגיאה בשליחת הבקשה: ' + e.message, true);
    }
  }

  // ---------- הערות ----------

  async refreshComments() {
    if (!this.project) return;
    const wrap = $('commentList');
    try {
      const comments = await this.repo.listComments(this.project.id);
      wrap.innerHTML = comments.length ? '' : '<p class="muted">אין הערות.</p>';
      for (const c of comments) {
        const div = document.createElement('div');
        div.className = 'comment-item';
        div.innerHTML = `${c.text}<br><span class="muted small">${c.author_email || ''} · ${new Date(c.created_at).toLocaleString('he-IL')}</span>`;
        wrap.appendChild(div);
      }
    } catch (e) {
      wrap.innerHTML = `<p class="muted">שגיאה: ${e.message}</p>`;
    }
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
    // כניסה / הרשמה / יציאה
    this._signupMode = false;
    $('toggleSignup').addEventListener('click', () => {
      this._signupMode = !this._signupMode;
      $('signupName').classList.toggle('hidden', !this._signupMode);
      $('loginSubmit').textContent = this._signupMode ? 'הרשמה וכניסה' : 'כניסה';
      $('toggleSignup').textContent = this._signupMode
        ? 'יש לי חשבון — כניסה' : 'אין לי חשבון — הרשמה';
    });
    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('loginEmail').value.trim();
      const password = $('loginPassword').value;
      try {
        if (this._signupMode) {
          await this.repo.signUp(email, password, $('signupName').value.trim());
        } else {
          await this.repo.signIn(email, password);
        }
        await this.#onLoggedIn();
      } catch (err) {
        this.toast('שגיאת כניסה: ' + err.message, true);
      }
    });
    $('logoutBtn').addEventListener('click', async () => {
      await this.repo.signOut();
      location.reload();
    });

    // אישור תוכנית ובקשות שינוי
    $('approveProject').addEventListener('click', async () => {
      try {
        await this.repo.approveProject(this.project.id, this.profile.email);
        this.project.approvedAt = new Date();
        this.project.approvedBy = this.profile.email;
        this.#updateApprovedBadge();
        this.toast('התוכנית אושרה');
      } catch (e) {
        this.toast('שגיאה באישור: ' + e.message, true);
      }
    });
    $('newRequest').addEventListener('click', () => this.#openRequestPopup());
    $('downloadSchematic').addEventListener('click', () => this.#downloadSchematic());
    $('saveSchematic').addEventListener('click', () => this.confirmPlan(false));
    $('deleteSchemOutlet').addEventListener('click', () => this.#schemDeleteSelected());

    // קבלת רכיב שנגרר מהמקרא אל השרטוט הנקי
    const schemVp = $('schemViewport');
    schemVp.addEventListener('dragover', (e) => {
      if (this.isEditor) e.preventDefault();
    });
    schemVp.addEventListener('drop', (e) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData('text/plain');
      if (!kind || !this.isEditor) return;
      const p = this.schemViewer.clientToPage(e.clientX, e.clientY);
      this.#schemAddOutlet(p.x, p.y, kind);
    });

    // כרטיסיית עריכה: שמירה, מחיקה וגרירה-ושחרור מהמקרא
    $('saveEdit').addEventListener('click', () => this.confirmPlan(false));
    $('deleteEditOutlet').addEventListener('click', () => this.#editDeleteSelected());
    const editVp = $('editViewport');
    editVp.addEventListener('dragover', (e) => {
      if (this.isEditor) e.preventDefault();
    });
    editVp.addEventListener('drop', (e) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData('text/plain');
      if (!kind || !this.isEditor) return;
      const p = this.editViewer.clientToPage(e.clientX, e.clientY);
      this.#editAddOutlet(p.x, p.y, kind);
    });
    $('sendRequest').addEventListener('click', () => this.#sendRequest());
    $('cancelRequest').addEventListener('click', () => $('requestPopup').classList.add('hidden'));
    $('addCommentBtn').addEventListener('click', async () => {
      const text = $('newCommentText').value.trim();
      if (!text) return;
      try {
        await this.repo.addComment(this.project.id, text, this.profile.email);
        $('newCommentText').value = '';
        this.refreshComments();
      } catch (e) {
        this.toast('שגיאה בשליחת ההערה: ' + e.message, true);
      }
    });

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
