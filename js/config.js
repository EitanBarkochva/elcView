// ===== הגדרות גלובליות =====

export const SUPABASE_URL = 'https://fbgyhdnrulvqejfocphk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_IJAC0BGXqfwqNTgjsk4AyQ_bIhx29eE';
export const STORAGE_BUCKET = 'plans';

// קנה מידה לרינדור השרטוט (פיקסלים לנקודת PDF)
export const RENDER_SCALE = 2;

// סוגי נקודות חשמל
export const OUTLET_KINDS = ['שקע', 'TV', 'תקשורת', 'אחר'];

// גובה ברירת מחדל לשקע שנוסף ידנית (ס"מ)
export const DEFAULT_HEIGHT_CM = 25;

// מילון שמות חדרים לזיהוי OCR — מילת מפתח ⇒ שם חדר מנורמל
export const ROOM_LEXICON = [
  { match: ['סלון', 'דיור', 'ר.דיור'], name: 'סלון' },
  { match: ['מטבח'], name: 'מטבח' },
  { match: ['אוכל'], name: 'פינת אוכל' },
  { match: ['משפחה'], name: 'פינת משפחה' },
  { match: ['ממ"ד', 'ממד', 'ממ״ד'], name: 'ממ"ד' },
  { match: ['מאסטר', 'הורים'], name: 'חדר הורים' },
  { match: ['שינה'], name: 'חדר שינה' },
  { match: ['חדר'], name: 'חדר' },
  { match: ['שירותים', 'שרותים'], name: 'שירותים' },
  { match: ['מקלחת', 'מקלחון', 'אמבטיה', 'רחצה'], name: 'מקלחת' },
  { match: ['כביסה'], name: 'חדר כביסה' },
  { match: ['מרפסת'], name: 'מרפסת' },
  { match: ['כניסה', 'הול'], name: 'כניסה' },
];

// שמות חדרים נפוצים להוספה ידנית מהירה
export const COMMON_ROOM_NAMES = [
  'סלון', 'מטבח', 'פינת אוכל', 'פינת משפחה', 'ממ"ד', 'חדר הורים',
  'חדר שינה', 'חדר ילדים', 'שירותים', 'מקלחת', 'חדר כביסה', 'מרפסת', 'כניסה',
];
