// ===== ייצוא הטבלה לקובץ אקסל (SheetJS) =====

export class ExcelExporter {
  /**
   * @param {string} projectName
   * @param {Room[]} rooms
   * @param {Outlet[]} outlets
   */
  export(projectName, rooms, outlets) {
    const XLSX = window.XLSX;
    const roomName = (id) => rooms.find((r) => r.id === id)?.name || 'ללא חדר';

    // מיון לפי חדר (״ללא חדר״ בסוף) ואז לפי גובה
    const sorted = [...outlets].sort((a, b) => {
      const an = roomName(a.roomId);
      const bn = roomName(b.roomId);
      if (an !== bn) {
        if (an === 'ללא חדר') return 1;
        if (bn === 'ללא חדר') return -1;
        return an.localeCompare(bn, 'he');
      }
      return (a.heightCm ?? 0) - (b.heightCm ?? 0);
    });

    const rows = sorted.map((o) => ({
      'חדר': roomName(o.roomId),
      'סוג נקודה': o.kind,
      'גובה מהרצפה (ס"מ)': o.heightCm ?? '',
      'מרחק מפינה (ס"מ)': o.cornerDistanceCm ?? '',
      'מעגל': o.circuit ?? '',
      'גובה נמדד (ס"מ)': o.measuredHeightCm ?? '',
      'מרחק נמדד (ס"מ)': o.measuredCornerCm ?? '',
      'תואם שרטוט': o.measureStatus === 'ok' ? '✓' : o.measureStatus === 'mismatch' ? '✗' : '',
      'בוצע': o.done ? '✓' : '✗',
      'הערות': o.notes || '',
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 8 },
      { wch: 14 }, { wch: 14 }, { wch: 11 }, { wch: 7 }, { wch: 40 },
    ];

    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] }; // גיליון מימין לשמאל
    XLSX.utils.book_append_sheet(wb, ws, 'ביקורת שקעים');
    XLSX.writeFile(wb, `${projectName || 'elcView'} - ביקורת שקעים.xlsx`);
  }
}
