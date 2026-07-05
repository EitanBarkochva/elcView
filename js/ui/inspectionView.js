// ===== מסך ביקורת — שלד לשלב ב' =====
// כרגע: בחירת חדר, פתיחת מצלמה אחורית ורשימת הנקודות בחדר.
// בשלב ב' יתווסף כאן זיהוי קופסה כתומה (סינון HSV) ומדידת מרחקים
// לפי קנה מידה של קופסת 55 מ"מ סטנדרטית.

export class InspectionView {
  /**
   * @param {object} els {roomSelect, video, placeholder, toggleBtn, checklist}
   */
  constructor(els) {
    this.els = els;
    this.stream = null;
    this.rooms = [];
    this.outlets = [];

    this.els.toggleBtn.addEventListener('click', () => this.toggleCamera());
    this.els.roomSelect.addEventListener('change', () => this.#renderChecklist());
  }

  setData(rooms, outlets) {
    this.rooms = rooms;
    this.outlets = outlets;
    const sel = this.els.roomSelect;
    sel.innerHTML = '';
    for (const r of rooms) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      sel.appendChild(opt);
    }
    this.#renderChecklist();
  }

  async toggleCamera() {
    if (this.stream) {
      this.stopCamera();
      return;
    }
    try {
      // מצלמה אחורית בטלפון; בדסקטופ תיפתח המצלמה הזמינה
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this.els.video.srcObject = this.stream;
      this.els.video.classList.remove('hidden');
      this.els.placeholder.classList.add('hidden');
      this.els.toggleBtn.textContent = '⏹ סגור מצלמה';
    } catch (err) {
      alert('לא ניתן לפתוח את המצלמה: ' + err.message);
    }
  }

  stopCamera() {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.els.video.srcObject = null;
    this.els.video.classList.add('hidden');
    this.els.placeholder.classList.remove('hidden');
    this.els.toggleBtn.textContent = '📷 פתח מצלמה';
  }

  #renderChecklist() {
    const roomId = this.els.roomSelect.value;
    const list = this.outlets.filter((o) => o.roomId === roomId);
    const wrap = this.els.checklist;
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<p class="muted">אין נקודות רשומות בחדר זה.</p>';
      return;
    }
    for (const o of list) {
      const div = document.createElement('div');
      div.className = 'check-item';
      div.innerHTML = `
        <span class="status">${o.done ? '✅' : '⬜'}</span>
        <span>${o.kind}</span>
        <span class="muted">גובה: ${o.heightCm ?? '?'} ס"מ, מרחק מפינה: ${o.cornerDistanceCm ?? '?'} ס"מ</span>`;
      wrap.appendChild(div);
    }
  }
}
