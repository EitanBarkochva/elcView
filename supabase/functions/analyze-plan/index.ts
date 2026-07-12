// ===== ניתוח שרטוט חשמל עם Claude =====
// פונקציית ענן: מקבלת את תמונת השרטוט + פריטי הטקסט שחולצו מה-PDF,
// שולחת ל-Claude (Opus 4.8) ומחזירה JSON מובנה של חדרים ונקודות חשמל.
// המפתח נשמר כסוד (ANTHROPIC_API_KEY) ולעולם לא מגיע לדפדפן.

import Anthropic from "npm:@anthropic-ai/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `אתה מומחה לקריאת תכניות חשמל ישראליות (ייצוא אוטוקאד).
המשתמש הוא חשמלאי שצריך טבלת ביקורת מדויקת של כל נקודות החשמל.

מוסכמות בשרטוטים אלה:
- תווית H=מספר ליד סמל = גובה הנקודה מהרצפה בס"מ.
- סמל שקע: עיגול קטן עם קווים בתוך חצי מסגרת על קיר. כמה סמלים צמודים = נקודה כפולה/משולשת/רביעייה.
- מספרי מעגלים בצורת "מספר/מספר" (כמו 4/2) צמודים לנקודות; כמה מספרי מעגלים צמודים לאותה נקודה מרמזים על כמות השקעים בה.
- TV = נקודת טלוויזיה, T או ת = נקודת תקשורת/טלפון.
- מרחק נקודה מקיר סמוך מסומן בקו מידה רציף שיוצא מהקיר אל הנקודה, עם מספר (בס"מ) ליד הקו. שים לב: מספרי מידות של קירות/חדרים אינם מרחקי שקעים.
- שמות חדרים כתובים בתוך החדרים: סלון/ר. דיור, מטבח, פ. אוכל, ממ"ד, מאסטר (=חדר הורים), חדר, מקלחת, שירותים, ח. כביסה, מרפסת וכו'.

תקבל: תמונת השרטוט + רשימת פריטי טקסט שחולצו מה-PDF עם קואורדינטות מדויקות
(מערכת צירים: נקודות עמוד, ראשית בפינה השמאלית-עליונה).
הפריטים מדויקים במיקום — העדף לעגן את התוצאות שלך לקואורדינטות מהרשימה,
והשתמש בתמונה כדי להבין את ההקשר: גבולות חדרים, שיוך תוויות לסמלים, כמות
סמלי שקעים בכל נקודה, ואיזה מספר מידה שייך לאיזו נקודה.

החזר בכל שדות הקואורדינטות ערכים באותה מערכת צירים של הפריטים.
כל נקודת חשמל בשרטוט חייבת להופיע ברשימת outlets — גם אם חסרים לה נתונים.
לגבולות חדרים (x0,y0,x1,y1) — עגן אותם לקירות האמיתיים שנראים בתמונה, לא רק סביב התווית.
אם אינך בטוח בערך, השאר null במקום לנחש.`;

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "שם החדר בעברית" },
          x0: { type: "number" },
          y0: { type: "number" },
          x1: { type: "number" },
          y1: { type: "number" },
        },
        required: ["name", "x0", "y0", "x1", "y1"],
        additionalProperties: false,
      },
    },
    outlets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          kind: { type: "string", enum: ["שקע", "TV", "תקשורת", "אחר"] },
          height_cm: { type: ["integer", "null"] },
          quantity: {
            type: "integer",
            description: "כמות שקעים בנקודה: 1 בודד, 2 כפול, 4 רביעייה",
          },
          corner_distance_cm: {
            type: ["integer", "null"],
            description: "מרחק מקיר סמוך לפי קו המידה, בס\"מ",
          },
          circuit: { type: ["string", "null"] },
          room: { type: ["string", "null"], description: "שם החדר שהנקודה בו" },
        },
        required: [
          "x", "y", "kind", "height_cm", "quantity",
          "corner_distance_cm", "circuit", "room",
        ],
        additionalProperties: false,
      },
    },
    notes: {
      type: "string",
      description: "הערות קצרות בעברית: אי-ודאויות, דברים שכדאי לבדוק ידנית",
    },
  },
  required: ["rooms", "outlets", "notes"],
  additionalProperties: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // חשוב לקרוא את הגוף לפני כל תשובה מוקדמת — תשובה בזמן שהלקוח עדיין
    // מעלה גוף גדול תוקעת את החיבור.
    const { image_base64, media_type, page, items } = await req.json();

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return json({ error: "missing_api_key" }, 500);
    }
    if (!image_base64 || !page) {
      return json({ error: "bad_request" }, 400);
    }

    const itemsText = (items ?? [])
      .map((i: { text: string; x: number; y: number; source: string }) =>
        `(${Math.round(i.x)},${Math.round(i.y)}) [${i.source}] ${i.text}`)
      .join("\n");

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: media_type ?? "image/png",
                data: image_base64,
              },
            },
            {
              type: "text",
              text:
                `מידות העמוד: רוחב ${page.width}, גובה ${page.height} (נקודות עמוד).\n` +
                `פריטי הטקסט שחולצו מה-PDF (קואורדינטה, מקור, טקסט):\n${itemsText}\n\n` +
                `נתח את השרטוט והחזר את כל החדרים ונקודות החשמל.`,
            },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return json({ error: "refusal" }, 502);
    }

    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    return json({
      analysis: JSON.parse(text),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });
  } catch (e) {
    console.error("analyze-plan error:", e);
    return json({ error: String(e) }, 500);
  }
});
