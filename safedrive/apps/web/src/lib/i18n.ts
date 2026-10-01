import { t as coreT, isRtl } from '@safedrive/core';

type Dict = Record<string, string>;
const he: Dict = {
  'nav.live': 'מפה חיה',
  'nav.drivers': 'נהגים ונסיעות',
  'nav.notifications': 'התראות',
  'nav.sos': 'SOS',
  'nav.family': 'הגדרות משפחה',
  'nav.demo': 'מצב הדגמה',
  'nav.admin': 'ניהול מערכת',
  'nav.logout': 'יציאה',
  'auth.login': 'כניסה',
  'auth.register': 'הרשמה',
  'auth.email': 'אימייל',
  'auth.password': 'סיסמה (10 תווים לפחות, אותיות וספרות)',
  'auth.name': 'שם מלא',
  'auth.noAccount': 'אין לך חשבון? הרשמה',
  'auth.haveAccount': 'כבר רשום/ה? כניסה',
  'family.create': 'יצירת משפחה',
  'family.name': 'שם המשפחה',
  'family.join': 'הצטרפות עם קוד הזמנה',
  'family.code': 'קוד הזמנה',
  'family.inviteDriver': 'הזמנת נהג/ת',
  'family.inviteParent': 'הזמנת הורה',
  'family.inviteCreated': 'קוד הזמנה (תקף 7 ימים, לשימוש אחד):',
  'family.members': 'חברי המשפחה',
  'family.emergency': 'אנשי קשר לחירום',
  'family.prefs': 'העדפות התראות',
  'consent.title': 'הסכמה לניטור נסיעות',
  'consent.text':
    'בהצטרפות כנהג/ת, מנהלי המשפחה יוכלו לראות את המיקום, המהירות והאירועים בזמן נסיעה פעילה בלבד. הניטור מופעל רק כשנסיעה מתחילה, תמיד מוצג על המסך, ואין מצב מעקב סמוי.',
  'consent.accept': 'אני מסכים/ה לניטור שקוף של הנסיעות שלי',
  'live.none': 'אין כרגע נסיעות פעילות',
  'live.lastUpdate': 'עדכון אחרון',
  'live.accuracy': 'דיוק GPS',
  'live.connection.online': 'מחובר',
  'live.connection.stale': 'עיכוב בנתונים',
  'live.connection.offline': 'אין חיבור',
  'live.confirming': 'בבדיקה (חוק 10 השניות)',
  'live.requestMonitoring': 'בקשת הפעלת ניטור',
  'live.requested': 'הבקשה נשלחה לנהג/ת',
  'drivers.noTrips': 'אין נסיעות עדיין',
  'trip.date': 'תאריך',
  'trip.duration': 'משך',
  'trip.distance': 'מרחק',
  'trip.avg': 'מהירות ממוצעת',
  'trip.max': 'מהירות מרבית',
  'trip.speeding': 'חריגות',
  'trip.critical': 'קריטיות',
  'trip.score': 'ציון',
  'trip.timeline': 'ציר זמן',
  'trip.speedChart': 'מהירות מול מגבלה',
  'trip.replay': 'הפעלה חוזרת',
  'trip.events': 'אירועי מהירות',
  'sos.ack': 'קיבלתי',
  'sos.resolve': 'טופל',
  'demo.title': 'מצב הדגמה',
  'demo.intro':
    'סימולציה מלאה בלי רכב, בלי GPS אמיתי ובלי ספקי מגבלות מהירות. כל הנתונים מסומנים כהדגמה ולא נכנסים לציון האמיתי.',
  'demo.createFamily': 'יצירת משפחת הדגמה',
  'demo.run': 'הפעלה',
  'demo.speed': 'האצת זמן',
  'common.save': 'שמירה',
  'common.add': 'הוספה',
  'common.delete': 'מחיקה',
  'common.loading': 'טוען…',
  'common.km': 'ק״מ',
  'common.unread': 'לא נקראו',
  'common.markAll': 'סימון הכל כנקרא',
  'common.realtime.online': 'עדכונים בזמן אמת',
  'common.realtime.offline': 'אין חיבור לעדכונים',
};
const en: Dict = {
  'nav.live': 'Live map',
  'nav.drivers': 'Drivers & trips',
  'nav.notifications': 'Notifications',
  'nav.sos': 'SOS',
  'nav.family': 'Family settings',
  'nav.demo': 'Demo mode',
  'nav.admin': 'System admin',
  'nav.logout': 'Log out',
  'auth.login': 'Log in',
  'auth.register': 'Sign up',
  'auth.email': 'Email',
  'auth.password': 'Password (10+ chars, letters and digits)',
  'auth.name': 'Full name',
  'auth.noAccount': 'No account? Sign up',
  'auth.haveAccount': 'Already registered? Log in',
  'family.create': 'Create family',
  'family.name': 'Family name',
  'family.join': 'Join with an invite code',
  'family.code': 'Invite code',
  'family.inviteDriver': 'Invite a driver',
  'family.inviteParent': 'Invite a parent',
  'family.inviteCreated': 'Invite code (valid 7 days, single use):',
  'family.members': 'Family members',
  'family.emergency': 'Emergency contacts',
  'family.prefs': 'Notification preferences',
  'consent.title': 'Trip monitoring consent',
  'consent.text':
    'As a driver, family administrators can see your location, speed and events during an active trip only. Monitoring runs only while a trip is active, is always shown on screen, and there is no covert mode.',
  'consent.accept': 'I agree to transparent monitoring of my trips',
  'live.none': 'No active trips right now',
  'live.lastUpdate': 'Last update',
  'live.accuracy': 'GPS accuracy',
  'live.connection.online': 'Connected',
  'live.connection.stale': 'Delayed',
  'live.connection.offline': 'Offline',
  'live.confirming': 'Confirming (10-second rule)',
  'live.requestMonitoring': 'Request monitoring',
  'live.requested': 'Request sent to the driver',
  'drivers.noTrips': 'No trips yet',
  'trip.date': 'Date',
  'trip.duration': 'Duration',
  'trip.distance': 'Distance',
  'trip.avg': 'Avg speed',
  'trip.max': 'Max speed',
  'trip.speeding': 'Speeding',
  'trip.critical': 'Critical',
  'trip.score': 'Score',
  'trip.timeline': 'Timeline',
  'trip.speedChart': 'Speed vs limit',
  'trip.replay': 'Replay',
  'trip.events': 'Speeding events',
  'sos.ack': 'Acknowledge',
  'sos.resolve': 'Resolved',
  'demo.title': 'Demo mode',
  'demo.intro':
    'Full simulation without a vehicle, real GPS or speed-limit providers. All data is labelled as demo and never affects real scores.',
  'demo.createFamily': 'Create demo family',
  'demo.run': 'Run',
  'demo.speed': 'Time speed-up',
  'common.save': 'Save',
  'common.add': 'Add',
  'common.delete': 'Delete',
  'common.loading': 'Loading…',
  'common.km': 'km',
  'common.unread': 'unread',
  'common.markAll': 'Mark all read',
  'common.realtime.online': 'Live updates',
  'common.realtime.offline': 'Live updates disconnected',
};

let lang: 'he' | 'en' = (localStorage.getItem('safedrive.lang') as 'he' | 'en' | null) ?? 'he';

export function getLang() {
  return lang;
}

export function setLang(l: 'he' | 'en') {
  lang = l;
  localStorage.setItem('safedrive.lang', l);
  document.documentElement.lang = l;
  document.documentElement.dir = isRtl(l) ? 'rtl' : 'ltr';
}

export function tr(key: string, vars: Record<string, string | number> = {}): string {
  const local = (lang === 'he' ? he : en)[key];
  if (local !== undefined)
    return local.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return coreT(lang, key, vars);
}

export function fmtTime(iso: string | number | null): string {
  if (iso === null) return '—';
  return new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', {
    timeZone: 'Asia/Jerusalem',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(iso));
}

export function fmtAgo(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  return rtf.format(-Math.round(s / 3600), 'hour');
}

setLang(lang);
