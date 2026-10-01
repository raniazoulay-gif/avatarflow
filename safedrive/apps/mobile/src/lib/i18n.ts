/** Mobile strings (Hebrew first, RTL) on top of the shared core dictionary. */
import { I18nManager } from 'react-native';
import { t as coreT, isRtl } from '@safedrive/core';

const he = {
  login: 'התחברות',
  register: 'הרשמה',
  email: 'אימייל',
  password: 'סיסמה',
  name: 'שם',
  noAccount: 'אין לך חשבון? להרשמה',
  haveAccount: 'יש לך חשבון? להתחברות',
  joinTitle: 'הצטרפות למשפחה',
  inviteCode: 'קוד הזמנה',
  consent:
    'אני מבין/ה ומסכים/ה שבזמן נסיעה פעילה המיקום, המהירות והאירועים שלי ישותפו עם ההורים במשפחה. הניטור תמיד גלוי ואפשר לסיים אותו בכל רגע.',
  join: 'הצטרף/י',
  createFamily: 'או: יצירת משפחה חדשה (הורה)',
  familyName: 'שם המשפחה',
  create: 'יצירה',
  startDriving: 'התחל נסיעה',
  endDriving: 'סיים נסיעה (לחיצה ארוכה)',
  permissions: 'הרשאות',
  locFg: 'מיקום בזמן שימוש',
  locBg: 'מיקום ברקע (לניווט במקביל)',
  granted: 'מאושר',
  missing: 'חסר',
  monitoringOn: 'הניטור פעיל - המשפחה רואה את הנסיעה',
  remoteOn: 'ניטור לבקשת הורה - פעיל וגלוי',
  monitoringRequest: '{name} מבקש/ת להפעיל ניטור נסיעה',
  accept: 'אישור והתחלה',
  decline: 'דחייה',
  sos: 'SOS',
  sosConfirm: 'לשלוח SOS למשפחה עם המיקום הנוכחי?',
  sosSent: 'SOS נשלח למשפחה',
  sosQueued: 'SOS נשמר וישלח כשיחזור החיבור',
  sosHint: 'שיחת חירום מתבצעת רק בלחיצה שלך - SafeDrive לעולם לא מחייגת לבד.',
  emergencyContacts: 'אנשי קשר לחירום',
  back: 'חזרה',
  offline: 'אין חיבור - הנתונים נשמרים במכשיר',
  queued: '{n} נקודות ממתינות לשליחה',
  confirming: 'מאמת חריגה…',
  speedingFor: 'חריגה כבר {sec} שנ׳',
  noLimit: 'מגבלת מהירות לא זמינה - לא נרשמת חריגה',
  openNav: 'פתח ניווט',
  demo: 'נסיעת הדגמה (סימולציה)',
  demoBadge: 'הדגמה - נתונים מדומים',
  liveTrips: 'נסיעות פעילות',
  noLiveTrips: 'אין כרגע נסיעות פעילות',
  notifications: 'התראות',
  logout: 'התנתקות',
  score: 'ציון',
  phoneUsage: 'זיהוי שימוש בטלפון',
  phoneUsageHint: 'אפשר לזהות רק שימוש ב-SafeDrive עצמה בזמן תנועה. שימוש באפליקציות אחרות חסום ע״י מערכת ההפעלה.',
  bgMissingHint: 'בלי מיקום ברקע הניטור נעצר כשעוברים לאפליקציית ניווט או נועלים מסך.',
  error: 'שגיאה',
};
type Key = keyof typeof he;
const en: Record<Key, string> = {
  login: 'Sign in',
  register: 'Sign up',
  email: 'Email',
  password: 'Password',
  name: 'Name',
  noAccount: 'No account? Sign up',
  haveAccount: 'Have an account? Sign in',
  joinTitle: 'Join a family',
  inviteCode: 'Invite code',
  consent:
    'I understand and agree that during an active trip my location, speed and events are shared with the parents in my family. Monitoring is always visible and I can end it at any time.',
  join: 'Join',
  createFamily: 'Or: create a new family (parent)',
  familyName: 'Family name',
  create: 'Create',
  startDriving: 'START DRIVING',
  endDriving: 'End trip (long press)',
  permissions: 'Permissions',
  locFg: 'Location while in use',
  locBg: 'Background location (for navigation apps)',
  granted: 'Granted',
  missing: 'Missing',
  monitoringOn: 'Monitoring active - your family can see this trip',
  remoteOn: 'Parent-requested monitoring - active and visible',
  monitoringRequest: '{name} asks you to start trip monitoring',
  accept: 'Accept and start',
  decline: 'Decline',
  sos: 'SOS',
  sosConfirm: 'Send SOS with your current location to your family?',
  sosSent: 'SOS sent to your family',
  sosQueued: 'SOS saved - it will be sent when the connection returns',
  sosHint: 'Emergency calls are only placed when you tap - SafeDrive never dials on its own.',
  emergencyContacts: 'Emergency contacts',
  back: 'Back',
  offline: 'Offline - data is stored on the device',
  queued: '{n} points waiting to upload',
  confirming: 'Confirming…',
  speedingFor: 'Speeding for {sec}s',
  noLimit: 'Speed limit unavailable - no violation is recorded',
  openNav: 'Open navigation',
  demo: 'Demo trip (simulation)',
  demoBadge: 'DEMO - simulated data',
  liveTrips: 'Live trips',
  noLiveTrips: 'No live trips right now',
  notifications: 'Notifications',
  logout: 'Sign out',
  score: 'Score',
  phoneUsage: 'Phone-usage detection',
  phoneUsageHint: 'Only interaction with SafeDrive itself while moving can be detected. Other apps are blocked by the OS.',
  bgMissingHint: 'Without background location, monitoring stops when you switch to a navigation app or lock the screen.',
  error: 'Error',
};

export let lang: 'he' | 'en' = 'he';

export function setLang(l: 'he' | 'en'): void {
  lang = l;
  const rtl = isRtl(l);
  if (I18nManager.isRTL !== rtl) {
    I18nManager.allowRTL(rtl);
    I18nManager.forceRTL(rtl); // takes effect after the next app reload
  }
}

export function s(key: Key, vars: Record<string, string | number> = {}): string {
  const raw = (lang === 'he' ? he : en)[key];
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

export const tc = (key: string, vars: Record<string, string | number> = {}): string => coreT(lang, key, vars);
