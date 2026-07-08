// ===== טבלת הסיכום — מקובצת לפי חדר =====
// עריכה מותרת רק בעמודות "בוצע" ו"הערות"; שאר העמודות לקריאה בלבד.

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
   */
  render(rooms, outlets) {
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
        <th>סוג נקודה</th>
        <th>כמות</th>
        <th>גובה מהרצפה (ס"מ)</th>
        <th>מרחק מפינה (ס"מ)</th>
        <th>מעגל</th>
        <th>נמדד בשטח</th>
        <th>בוצע</th>
        <th>הערות</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');

    for (const [name, group] of sortedGroups) {
      const header = document.createElement('tr');
      header.className = 'room-header';
      const totalSockets = group.reduce((s, o) => s + (o.quantity || 1), 0);
      header.innerHTML = `<td colspan="8">🏠 ${name} — ${group.length} נקודות (${totalSockets} שקעים)</td>`;
      tbody.appendChild(header);

      group.sort((a, b) => (a.heightCm ?? 0) - (b.heightCm ?? 0));
      for (const o of group) tbody.appendChild(this.#row(o));
    }

    table.appendChild(tbody);
    this.container.innerHTML = '';
    this.container.appendChild(table);
  }

  #row(outlet) {
    const tr = document.createElement('tr');
    tr.classList.toggle('done-row', outlet.done);

    // עמודות קריאה בלבד
    const measured = outlet.measuredHeightCm != null
      ? `${outlet.measureStatus === 'ok' ? '✓' : outlet.measureStatus === 'mismatch' ? '✗' : ''} ` +
        `${outlet.measuredHeightCm}${outlet.measuredCornerCm != null ? ` / ${outlet.measuredCornerCm}` : ''}`
      : '—';
    const qtyText = { 1: '1', 2: '2 (כפול)', 3: '3 (משולש)', 4: '4 (רביעייה)' }[outlet.quantity] || outlet.quantity;
    for (const val of [
      outlet.kind,
      qtyText,
      outlet.heightCm ?? '—',
      outlet.cornerDistanceCm ?? '—',
      outlet.circuit ?? '—',
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
    input.placeholder = 'הערה...';
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
