// ===== שכבת הנתונים — Supabase =====

import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from '../config.js';
import { Project, Room, Outlet } from '../models.js';

export class SupabaseRepo {
  constructor() {
    this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  // ---------- פרויקטים ----------

  async listProjects() {
    const { data, error } = await this.client
      .from('projects').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data.map(Project.fromRow);
  }

  /** יוצר פרויקט: מעלה את ה-PDF ל-Storage ושומר רשומה */
  async createProject(name, pdfFile) {
    const project = new Project({ name });
    const path = `${project.id}/${Date.now()}.pdf`;
    const { error: upErr } = await this.client.storage
      .from(STORAGE_BUCKET)
      .upload(path, pdfFile, { contentType: 'application/pdf' });
    if (upErr) throw upErr;
    project.pdfPath = path;

    const { error } = await this.client.from('projects').insert(project.toRow());
    if (error) throw error;
    return project;
  }

  async deleteProject(projectId) {
    const { error } = await this.client.from('projects').delete().eq('id', projectId);
    if (error) throw error;
  }

  /** מוריד את קובץ ה-PDF של פרויקט כ-ArrayBuffer */
  async downloadPdf(pdfPath) {
    const { data, error } = await this.client.storage
      .from(STORAGE_BUCKET).download(pdfPath);
    if (error) throw error;
    return await data.arrayBuffer();
  }

  // ---------- חדרים ושקעים ----------

  async loadRooms(projectId) {
    const { data, error } = await this.client
      .from('rooms').select('*').eq('project_id', projectId).order('created_at');
    if (error) throw error;
    return data.map(Room.fromRow);
  }

  async loadOutlets(projectId) {
    const { data, error } = await this.client
      .from('outlets').select('*').eq('project_id', projectId).order('created_at');
    if (error) throw error;
    return data.map(Outlet.fromRow);
  }

  /** שומר את כל מצב הזיהוי: מוחק את הקיים ומכניס מחדש (עמוד יחיד — פשוט ואמין) */
  async saveDetection(projectId, rooms, outlets) {
    // מחיקת שקעים לפני חדרים בגלל ה-FK
    let res = await this.client.from('outlets').delete().eq('project_id', projectId);
    if (res.error) throw res.error;
    res = await this.client.from('rooms').delete().eq('project_id', projectId);
    if (res.error) throw res.error;

    if (rooms.length) {
      res = await this.client.from('rooms').insert(rooms.map((r) => r.toRow()));
      if (res.error) throw res.error;
    }
    if (outlets.length) {
      // רשת ביטחון: מאפסים room_id שאינו מפנה לחדר קיים (מונע הפרת FK)
      const validRoomIds = new Set(rooms.map((r) => r.id));
      const rows = outlets.map((o) => {
        const row = o.toRow();
        if (row.room_id && !validRoomIds.has(row.room_id)) row.room_id = null;
        return row;
      });
      res = await this.client.from('outlets').insert(rows);
      if (res.error) throw res.error;
    }
  }

  /** עדכון נקודתי של שקע (בוצע / הערות) — autosave מהטבלה */
  async updateOutlet(outletId, patch) {
    const { error } = await this.client
      .from('outlets')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', outletId);
    if (error) throw error;
  }
}
