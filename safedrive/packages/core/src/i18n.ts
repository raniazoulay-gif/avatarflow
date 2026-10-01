/**
 * Minimal, dependency-free i18n shared by web and mobile. Hebrew is the first
 * language (RTL); English is complete as the second. Plurals use Intl.PluralRules.
 */
export type Lang = 'he' | 'en';
export const RTL_LANGS: readonly string[] = ['he', 'ar'];
export const isRtl = (lang: string): boolean => RTL_LANGS.includes(lang);

type Dict = Record<string, string>;

const he: Dict = {
  'app.name': 'SafeDrive',
  'app.tagline': 'נוהגים בטוח. יודעים יותר. שומרים על המשפחה.',
  'severity.SAFE': 'תקין',
  'severity.ATTENTION': 'שימו לב',
  'severity.WARNING': 'אזהרה',
  'severity.CRITICAL': 'מסוכן',
  'status.LIMIT_UNAVAILABLE': 'מגבלת מהירות לא זמינה',
  'status.GPS_UNRELIABLE': 'GPS לא מדויק',
  'speed.current': 'מהירות נוכחית',
  'speed.limit': 'מגבלת מהירות',
  'speed.limitUnavailable': 'מגבלת מהירות לא זמינה',
  'speed.excess': 'חריגה',
  'speed.duration': 'משך',
  'speed.max': 'מהירות מרבית',
  'unit.kmh': 'קמ״ש',
  'unit.mph': 'מייל לשעה',
  'trip.start': 'התחל נסיעה',
  'trip.stop': 'סיים נסיעה',
  'trip.monitoringActive': 'הניטור פעיל - המשפחה רואה את הנסיעה',
  'trip.monitoringOff': 'הניטור כבוי',
  'trip.started': '{name} התחיל/ה לנהוג',
  'trip.ended': '{name} סיים/ה נסיעה',
  'event.speeding': 'מהירות מופרזת',
  'event.HARD_BRAKING': 'בלימה חדה',
  'event.HARD_ACCELERATION': 'האצה חדה',
  'event.SOS': 'קריאת SOS',
  'notify.speeding': '{name}: {severity} - {speed} קמ״ש באזור {limit} קמ״ש',
  'notify.speedingEnded': '{name}: המהירות חזרה לתקין ({duration})',
  'notify.sos': '🚨 {name} הפעיל/ה SOS',
  'notify.monitoringRequest': '{name} מבקש/ת להפעיל ניטור נסיעה',
  'notify.hardBraking': '{name}: בלימה חדה',
  'notify.hardAcceleration': '{name}: האצה חדה',
  'notify.offline': '{name}: אין חיבור למכשיר',
  'notify.gps': '{name}: אין קליטת GPS',
  'notify.permission': '{name}: חסרה הרשאת מיקום - הניטור לא יכול לפעול',
  'notify.ended': '{name} סיים/ה נסיעה ({duration})',
  'emergency.police': 'משטרה',
  'emergency.ambulance': 'מד״א',
  'emergency.fire': 'כבאות והצלה',
  'score.title': 'ציון בטיחות SafeDrive',
  'score.speeding': 'מהירות',
  'score.hardBraking': 'בלימות חדות',
  'score.hardAcceleration': 'האצות חדות',
  'score.phoneUsage': 'שימוש בטלפון',
  'trips.count': '{count, plural, one {נסיעה אחת} two {שתי נסיעות} other {# נסיעות}}',
  'demo.badge': 'נתוני הדגמה (סימולציה)',
};

const en: Dict = {
  'app.name': 'SafeDrive',
  'app.tagline': 'Drive Safe. Know More. Protect Your Family.',
  'severity.SAFE': 'Safe',
  'severity.ATTENTION': 'Attention',
  'severity.WARNING': 'Warning',
  'severity.CRITICAL': 'Critical',
  'status.LIMIT_UNAVAILABLE': 'Speed limit unavailable',
  'status.GPS_UNRELIABLE': 'GPS inaccurate',
  'speed.current': 'Current speed',
  'speed.limit': 'Speed limit',
  'speed.limitUnavailable': 'Speed limit unavailable',
  'speed.excess': 'Excess',
  'speed.duration': 'Duration',
  'speed.max': 'Max speed',
  'unit.kmh': 'km/h',
  'unit.mph': 'mph',
  'trip.start': 'START DRIVING',
  'trip.stop': 'End trip',
  'trip.monitoringActive': 'Monitoring is ON - your family can see this trip',
  'trip.monitoringOff': 'Monitoring is off',
  'trip.started': '{name} started driving',
  'trip.ended': '{name} finished a trip',
  'event.speeding': 'Speeding',
  'event.HARD_BRAKING': 'Hard braking',
  'event.HARD_ACCELERATION': 'Hard acceleration',
  'event.SOS': 'SOS',
  'notify.speeding': '{name}: {severity} - {speed} km/h in a {limit} km/h zone',
  'notify.speedingEnded': '{name}: back to a safe speed ({duration})',
  'notify.sos': '🚨 {name} triggered SOS',
  'notify.monitoringRequest': '{name} asks to start trip monitoring',
  'notify.hardBraking': '{name}: hard braking',
  'notify.hardAcceleration': '{name}: hard acceleration',
  'notify.offline': '{name}: device offline',
  'notify.gps': '{name}: no GPS signal',
  'notify.permission': '{name}: location permission missing - monitoring cannot run',
  'notify.ended': '{name} finished a trip ({duration})',
  'emergency.police': 'Police',
  'emergency.ambulance': 'Ambulance (MDA)',
  'emergency.fire': 'Fire & Rescue',
  'score.title': 'SafeDrive Safety Score',
  'score.speeding': 'Speeding',
  'score.hardBraking': 'Hard braking',
  'score.hardAcceleration': 'Hard acceleration',
  'score.phoneUsage': 'Phone usage',
  'trips.count': '{count, plural, one {# trip} other {# trips}}',
  'demo.badge': 'Demo data (simulated)',
};

export const MESSAGES: Record<Lang, Dict> = { he, en };

function plural(template: string, lang: string, vars: Record<string, string | number>): string {
  return template.replace(
    /\{(\w+), plural, ((?:\w+ \{[^}]*\}\s*)+)\}/g,
    (_m, name: string, body: string) => {
      const n = Number(vars[name] ?? 0);
      const cases: Record<string, string> = {};
      for (const [, k, v] of body.matchAll(/(\w+) \{([^}]*)\}/g)) cases[k as string] = v as string;
      const cat = new Intl.PluralRules(lang).select(n);
      const chosen = cases[cat] ?? cases.other ?? '';
      return chosen.replace(/#/g, new Intl.NumberFormat(lang).format(n));
    },
  );
}

export function t(lang: string, key: string, vars: Record<string, string | number> = {}): string {
  const dict = MESSAGES[(lang as Lang)] ?? MESSAGES.he;
  const raw = dict[key] ?? MESSAGES.en[key] ?? key;
  const withPlural = plural(raw, lang, vars);
  return withPlural.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDateTime(epochMs: number, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(epochMs));
}
