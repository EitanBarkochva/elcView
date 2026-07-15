// ===== שכבת הנתונים — Supabase =====

import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from '../config.js';
import { Project, Room, Outlet } from '../models.js';

export class SupabaseRepo {
  constructor() {
    this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  // ---------- אימות ומשתמשים ----------

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  }

  /** הרשמה; נרשם חדש מקבל תפקיד "לקוח" אוטומטית */
  async signUp(email, password, name) {
    const { error } = await this.client.auth.signUp({
      email, password, options: { data: { name } },
    });
    if (error) throw error;
    // אישור המייל אוטומטי בצד השרת — נכנסים מיד
    return this.signIn(email, password);
  }

  async signOut() {
    await this.client.auth.signOut();
  }

  async getSession() {
    const { data } = await this.client.auth.getSession();
    return data.session;
  }

  /** הפרופיל (כולל תפקיד) של המשתמש המחובר */
  async getMyProfile() {
    const session = await this.getSession();
    if (!session) return null;
    const { data, error } = await this.client
      .from('profiles').select('*').eq('id', session.user.id).single();
    if (error) throw error;
    return data;
  }

  async listProfiles() {
    const { data, error } = await this.client
      .from('profiles').select('*').order('created_at');
    if (error) throw error;
    return data;
  }

  async setRole(profileId, role) {
    const { error } = await this.client
      .from('profiles').update({ role }).eq('id', profileId);
    if (error) throw error;
  }

  // ---------- אישור תוכנית ----------

  async approveProject(projectId, email) {
    const { error } = await this.client.from('projects')
      .update({ approved_at: new Date().toISOString(), approved_by: email })
      .eq('id', projectId);
    if (error) throw error;
  }

  // ---------- בקשות שינוי ----------

  async listRequests(projectId) {
    const { data, error } = await this.client
      .from('change_requests').select('*')
      .eq('project_id', projectId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async createRequest(row) {
    const { error } = await this.client.from('change_requests').insert(row);
    if (error) throw error;
  }

  async updateRequest(id, patch) {
    const { error } = await this.client
      .from('change_requests').update(patch).eq('id', id);
    if (error) throw error;
  }

  // ---------- הערות ----------

  async listComments(projectId) {
    const { data, error } = await this.client
      .from('comments').select('*')
      .eq('project_id', projectId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async addComment(projectId, text, authorEmail) {
    const { error } = await this.client.from('comments')
      .insert({ project_id: projectId, text, author_email: authorEmail });
    if (error) throw error;
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
