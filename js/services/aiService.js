// ===== ניתוח AI — שליחת השרטוט ל-Claude דרך פונקציית הענן =====
// התמונה + פריטי הטקסט נשלחים ל-Edge Function (analyze-plan), שמחזיקה
// את מפתח ה-API של Anthropic כסוד ומחזירה JSON מובנה של חדרים ונקודות.

// הרזולוציה המקסימלית שמנוצלת היטב ע"י ראיית המודל (צלע ארוכה, בפיקסלים)
const MAX_IMAGE_EDGE = 2400;

export class AiAnalyzer {
  /** @param {SupabaseClient} supabaseClient הלקוח מ-SupabaseRepo */
  constructor(supabaseClient) {
    this.client = supabaseClient;
  }

  /**
   * שולח את השרטוט לניתוח ומחזיר {rooms, outlets, notes} בקואורדינטות עמוד.
   * @param {HTMLCanvasElement} canvas קנבס הרינדור של השרטוט
   * @param {Array<{text,x,y,source}>} items פריטי הטקסט מ-PdfService
   * @param {{width,height}} pageSize מידות העמוד בנקודות
   */
  async analyze(canvas, items, pageSize) {
    const { data, error } = await this.client.functions.invoke("analyze-plan", {
      body: {
        image_base64: this.#canvasToBase64(canvas),
        media_type: "image/png",
        page: { width: Math.round(pageSize.width), height: Math.round(pageSize.height) },
        items: items.map((i) => ({
          text: i.text,
          x: Math.round(i.x),
          y: Math.round(i.y),
          source: i.source || "text",
        })),
      },
    });

    if (error) {
      // ננסה לחלץ את גוף השגיאה מהפונקציה (missing_api_key וכו')
      let detail = error.message;
      try {
        const body = await error.context?.json();
        if (body?.error) detail = body.error;
      } catch { /* אין גוף */ }
      if (detail === "missing_api_key") {
        throw new Error(
          'לא הוגדר מפתח API. יש להוסיף סוד בשם ANTHROPIC_API_KEY ' +
          'בלוח הבקרה של Supabase: Edge Functions ← Secrets.',
        );
      }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    return data.analysis;
  }

  /** מקטין את הקנבס במידת הצורך ומחזיר PNG כ-base64 (בלי הקידומת) */
  #canvasToBase64(canvas) {
    let source = canvas;
    const longEdge = Math.max(canvas.width, canvas.height);
    if (longEdge > MAX_IMAGE_EDGE) {
      const k = MAX_IMAGE_EDGE / longEdge;
      const off = document.createElement("canvas");
      off.width = Math.round(canvas.width * k);
      off.height = Math.round(canvas.height * k);
      off.getContext("2d").drawImage(canvas, 0, 0, off.width, off.height);
      source = off;
    }
    return source.toDataURL("image/png").split(",")[1];
  }
}
