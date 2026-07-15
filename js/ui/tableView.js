// ===== טבלת הסיכום =====
// מבנה העמודות (לפי בקשת המשתמש): שם חדר | כמות שקעים | גובה מהרצפה |
// מרחק מקיר סמוך (קו המידה בשרטוט) | נמדד בשטח | בוצע | הערות.
// עריכה מותרת רק בעמודות "בוצע" ו"הערות"; שאר העמודות לקריאה בלבד.
// תא שם החדר ממוזג (rowspan) לכל נקודות החדר.

export class TableView {
  /**
   * @param {HTMLElement} container
   * @param {(outlet, patch) => void} onOutletEdit  נקרא בשינוי בוצע/הערות
   */
  constructor(container, onOutletEdit) {
    this.container = container;
    this.onOutletEdit = onOutletEdit;
  }

  /**
   * @param {Room[]} rooms
   * @param {Outlet[]} outlets
   * @param {boolean} readOnly תצוגת לקוח — בלי עריכה כלל
   */
  render(rooms, outlets, readOnly = false) {
    this.readOnly = readOnly;
    const roomName = (id) => rooms.find((r) => r.id === id)?.name || 'ללא חדר';

    // קיבוץ לפי חדר, בסדר עברי, "ללא חדר" בסוף
    const groups = new Map();
    for (const o of outlets) {
      const name = roomName(o.roomId);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(o);
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => {
      if (a[0] === 'ללא חדר') return 1;
      if (b[0] === 'ללא חדר') return -1;
      return a[0].localeCompare(b[0], 'he');
    });

    const table = document.createElement('table');
    table.className = 'summary';
    table.innerHTML = `
      <thead><tr>
        <th>חדר</th>
        <th>מזהה</th>
        <th>כמות שקעים</th>
        <th>גובה מהרצפה (ס"מ)</th>
        <th>מרחק מקיר סמוך (ס"מ)</th>
        <th>נמדד בשטח</th>
        <th>בוצע</th>
        <th>הערות</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');

    for (const [name, group] of sortedGroups) {
      // מיון לפי המספר הרץ במזהה (סדר ההליכה מהפתח); בלי מזהה — לפי גובה
      const labelNum = (o) => {
        const m = o.label?.match(/(\d+)\s*$/);
        return m ? parseInt(m[1], 10) : Infinity;
      };
      group.sort((a, b) => {
        const d = labelNum(a) - labelNum(b);
        return d !== 0 ? d : (a.heightCm ?? 0) - (b.heightCm ?? 0);
      });
      const totalSockets = group.reduce((s, o) => s + (o.quantity || 1), 0);

      group.forEach((o, idx) => {
        const tr = this.#row(o);
        if (idx === 0) {
          // תא החדר ממוזג על כל שורות החדר
          const tdRoom = document.createElement('td');
          tdRoom.className = 'room-cell';
          tdRoom.rowSpan = group.length;
          tdRoom.innerHTML = `<b>${name}</b><br>
            <span class="muted small">${group.length} נקודות · ${totalSockets} שקעים</span>`;
          tr.prepend(tdRoom);
        }
        tbody.appendChild(tr);
      });
    }

    table.appendChild(tbody);
    this.container.innerHTML = '';
    this.container.appendChild(table);
  }

  #row(outlet) {
    const tr = document.createElement('tr');
    tr.classList.toggle('done-row', outlet.done);

    const qty = outlet.quantity || 1;
    const qtyText = `${qty} × ${outlet.kind}` +
      ({ 2: ' (כפול)', 3: ' (משולש)', 4: ' (רביעייה)' }[qty] || '');

    const measured = outlet.measuredHeightCm != null
      ? `${outlet.measureStatus === 'ok' ? '✓' : outlet.measureStatus === 'mismatch' ? '✗' : ''} ` +
        `${outlet.measuredHeightCm}${outlet.measuredCornerCm != null ? ` / ${outlet.measuredCornerCm}` : ''}`
      : '—';

    // עמודות קריאה בלבד
    for (const val of [
      outlet.label ?? '—',
      qtyText,
      outlet.heightCm ?? '—',
      outlet.cornerDistanceCm ?? '—',
      measured,
    ]) {
      const td = document.createElement('td');
      td.className = 'ro';
      td.textContent = val;
      tr.appendChild(td);
    }

    // בוצע — checkbox
    const tdDone = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = outlet.done;
    cb.disabled = this.readOnly;
    cb.addEventListener('change', () => {
      outlet.done = cb.checked;
      tr.classList.toggle('done-row', outlet.done);
      this.onOutletEdit(outlet, { done: outlet.done });
    });
    tdDone.appendChild(cb);
    tr.appendChild(tdDone);

    // הערות — טקסט עם שמירה מושהית
    const tdNotes = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = outlet.notes || '';
    input.placeholder = this.readOnly ? '' : 'הערה...';
    input.readOnly = this.readOnly;
    let timer = null;
    input.addEventListener('input', () => {
      outlet.notes = input.value;
      clearTimeout(timer);
      timer = setTimeout(() => this.onOutletEdit(outlet, { notes: outlet.notes }), 600);
    });
    tdNotes.appendChild(input);
    tr.appendChild(tdNotes);

    return tr;
  }
}
