// ===== האפליקציה הראשית — חיווט מסכים, זרימה ומצב =====

import { OUTLET_KINDS, DEFAULT_HEIGHT_CM, COMMON_ROOM_NAMES } from './config.js';
import { Room, Outlet } from './models.js';
import { PdfService } from './services/pdfService.js';
import { PlanDetector } from './services/detector.js';
import { OcrService } from './services/ocrService.js';
import { SupabaseRepo } from './services/db.js';
import { ExcelExporter } from './services/excelExporter.js';
import { PlanViewer } from './ui/planViewer.js';
import { TableView } from './ui/tableView.js';
import { InspectionView } from './ui/inspectionView.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.repo = new SupabaseRepo();
    this.pdf = new PdfService();
    this.detector = new PlanDetector();
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

    // זיהוי אוטומטי משכבת הטקסט
    this.setStatus('מזהה שקעים משכבת הטקסט...');
    const textItems = await this.pdf.extractTextItems();
    this.outlets = this.detector.detectOutlets(textItems, this.project.id);
    this.rooms = [];
    this.viewer.setData(this.rooms, this.outlets);
    this.setStatus(`זוהו ${this.outlets.length} נקודות. הרץ OCR לזיהוי חדרים או סמן ידנית.`);

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
        // פרויקט שטרם אושר — מריצים זיהוי מחדש משכבת הטקסט
        const textItems = await this.pdf.extractTextItems();
        this.outlets = this.detector.detectOutlets(textItems, project.id);
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
    this.viewer.setMode('pan');
    this.#setToolButtons('modePan');
  }

  reassignRooms() {
    this.detector.assignOutletsToRooms(this.outlets, this.rooms);
  }

  async runOcr() {
    const btn = $('runOcr');
    btn.disabled = true;
    try {
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
      this.viewer.renderAll();
      this.setStatus(`OCR זיהה ${added} חדרים חדשים. גרור ומתח את המלבנים לגבולות האמיתיים.`);
    } catch (e) {
      this.setStatus('שגיאת OCR: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async confirmPlan() {
    if (!this.outlets.length) {
      this.toast('אין נקודות לשמירה — הוסף שקעים על השרטוט', true);
      return;
    }
    try {
      this.reassignRooms();
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
    for (const k of OUTLET_KINDS) {
      kindSel.add(new Option(k, k, false, k === outlet.kind));
    }
    kindSel.addEventListener('change', () => {
      outlet.kind = kindSel.value;
      this.viewer.refreshOutlet(outlet);
    });

    const height = this.#labeled(panel, 'גובה מהרצפה (ס"מ)', 'input');
    height.type = 'number';
    height.value = outlet.heightCm ?? '';
    height.addEventListener('input', () => {
      outlet.heightCm = height.value === '' ? null : parseInt(height.value, 10);
      this.viewer.refreshOutlet(outlet);
    });

    const dist = this.#labeled(panel, 'מרחק מפינת הקיר (ס"מ)', 'input');
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
    for (const id of ['modePan', 'modeAddOutlet', 'modeAddRoom']) {
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
    $('zoomIn').addEventListener('click', () => this.viewer.zoomBy(1.25));
    $('zoomOut').addEventListener('click', () => this.viewer.zoomBy(1 / 1.25));
    $('zoomFit').addEventListener('click', () => this.viewer.fit());
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
