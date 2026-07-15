// ===== מודל הנתונים =====
// כל הקואורדינטות (x, y, bounds) נשמרות ביחידות של עמוד ה-PDF (נקודות),
// כך שהן בלתי תלויות ברזולוציית הרינדור.

function uuid() {
  return crypto.randomUUID();
}

export class Project {
  constructor({
    id = uuid(), name = '', pdf_path = null, created_at = null,
    approved_at = null, approved_by = null,
  } = {}) {
    this.id = id;
    this.name = name;
    this.pdfPath = pdf_path;
    this.createdAt = created_at ? new Date(created_at) : new Date();
    this.approvedAt = approved_at ? new Date(approved_at) : null;
    this.approvedBy = approved_by;
  }

  toRow() {
    return { id: this.id, name: this.name, pdf_path: this.pdfPath };
  }

  static fromRow(row) {
    return new Project(row);
  }
}

export class Room {
  constructor({
    id = uuid(), project_id = null, name = 'חדר', bounds = null, entrance = null,
  } = {}) {
    this.id = id;
    this.projectId = project_id;
    this.name = name;
    // bounds: {x, y, w, h} בקואורדינטות PDF, או null אם לא הוגדר מלבן
    this.bounds = bounds;
    // entrance: {x, y} — נקודת הפתח של החלל, ממנה מתחיל המספור
    this.entrance = entrance;
  }

  contains(x, y) {
    const b = this.bounds;
    return !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }

  toRow() {
    return {
      id: this.id, project_id: this.projectId, name: this.name,
      bounds: this.bounds, entrance: this.entrance,
    };
  }

  static fromRow(row) {
    return new Room(row);
  }
}

export class Outlet {
  constructor({
    id = uuid(), project_id = null, room_id = null, kind = 'שקע',
    height_cm = null, corner_distance_cm = null, x = 0, y = 0,
    circuit = null, done = false, notes = '', quantity = 1, label = null,
    measured_height_cm = null, measured_corner_cm = null, measure_status = null,
  } = {}) {
    this.id = id;
    this.projectId = project_id;
    this.roomId = room_id;
    this.kind = kind;
    this.heightCm = height_cm;
    this.cornerDistanceCm = corner_distance_cm;
    this.x = x;
    this.y = y;
    this.circuit = circuit;
    this.done = done;
    this.notes = notes;
    this.quantity = quantity; // 1=בודד, 2=כפול, 4=רביעייה
    this.label = label; // מזהה המוצר: "מטבח-3" (שם חלל + מספר רץ מהפתח)
    // תוצאות מדידה מהביקורת בשטח (שלבים ב'-ד')
    this.measuredHeightCm = measured_height_cm;
    this.measuredCornerCm = measured_corner_cm;
    this.measureStatus = measure_status; // 'ok' | 'mismatch' | null
  }

  toRow() {
    return {
      id: this.id,
      project_id: this.projectId,
      room_id: this.roomId,
      kind: this.kind,
      height_cm: this.heightCm,
      corner_distance_cm: this.cornerDistanceCm,
      x: this.x,
      y: this.y,
      circuit: this.circuit,
      done: this.done,
      notes: this.notes,
      quantity: this.quantity,
      label: this.label,
      measured_height_cm: this.measuredHeightCm,
      measured_corner_cm: this.measuredCornerCm,
      measure_status: this.measureStatus,
    };
  }

  static fromRow(row) {
    return new Outlet(row);
  }
}
