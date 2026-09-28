# זיכרון פרויקט: Gmail Invoice Automation

> **קובץ המקור לסקיל "חשבוניות".** יש לעדכן אותו בסוף כל סשן עבודה.
> אין כאן מפתחות, טוקנים או סיסמאות, וגם אסור להוסיף אותם.
> עודכן לאחרונה: 2026-09-28 (ערב: נוספה אפליקציית ה-SaaS לכמה לקוחות)

## מה המערכת עושה

מזהה חשבוניות שמגיעות ל-Gmail של רן (raniazoulay@gmail.com), מתייגת אותן, שולחת התראה, שומרת אותן לתיקייה במחשב ומפיקה דוח Excel יומי. במצב Production היא גם מעבירה את החשבוניות לתיבת Gmail אחרת.

## איפה הכול נמצא

| רכיב | מיקום |
|---|---|
| קוד | GitHub `raniazoulay-gif/avatarflow`, **ענף `claude/gmail-invoice-detection-lsqsrg`**, תיקייה `invoice-automation/`. עוד לא מוזג ל-main, ואין PR |
| שרת | Railway, פרויקט **"GMAIL invoice-automation"** (נפרד מ-AvatarFlow), שירות "GMAIL invoice-automation" + Postgres |
| Root Directory ב-Railway | `invoice-automation`. ה-Branch מחובר ל-`claude/gmail-invoice-detection-lsqsrg`, ו-Railway עושה Deploy אוטומטי בכל push |
| כתובת ציבורית | `https://gmail-invoice-automation-production.up.railway.app` (דפים: `/`, `/privacy`, `/terms`, `/health`) |
| Google Cloud | פרויקט **"GMAIL invoice-automation"**, Gmail API מופעל. OAuth consent: External, **In production** (לא פג אחרי 7 ימים). Client מסוג Web application בשם "Invoice Automation", redirect URI הוא OAuth Playground |
| AI | Anthropic, מודל `claude-haiku-4-5-20251001` (זול). רן לא רוצה עלויות שוטפות גבוהות: טעינה חד-פעמית של כ-5$, בלי Auto-reload |
| שמירה מקומית | `C:\InvoiceSaver` במחשב של רן (Windows, Python 3.14.3). Task Scheduler "Invoice Saver" רץ כל 10 דקות וגם בכניסה ל-Windows |
| תיקיית החשבוניות | `C:\Users\Ran Azoulay\OneDrive - Matrix IT Ltd\Desktop\Desktop\Drive\RAN\Claude\SKILL\GOOD\Gmail Invoice Automation\חשבוניות\YYYY-MM\` |

## משתנים ב-Railway (שמות בלבד)

`DATABASE_URL=${{Postgres.DATABASE_URL}}`, `DRY_RUN=true`, `AUTO_FORWARD_ENABLED=false`, `PRODUCTION_CONFIRMATION=false`, `TIMEZONE=Asia/Jerusalem`, `DAILY_REPORT_TIME=18:00`, `REPORTS_DIR=/tmp/reports`, `SOURCE_GMAIL_ACCOUNT=raniazoulay@gmail.com`, `PUBLIC_CONTACT_EMAIL=raniazoulay@gmail.com`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `AI_API_KEY`, `AI_MODEL=claude-haiku-4-5-20251001`.
**לא מוגדרים עדיין:** `TARGET_GMAIL_ACCOUNT` (בכוונה, עד Production), `BACKFILL_DAYS`.
ברירות מחדל שחשוב להכיר: `NOTIFY_DETECTIONS=dry_run`, סף העברה 0.90, סף בדיקה 0.70, משקלות AI 0.7 / חוקים 0.3.

## מצב נוכחי (2026-09-28)

- ✅ המערכת רצה ב-Railway ב-**DRY RUN**. SYSTEM CHECK: Gmail CONNECTED, AI CONNECTED (Haiku), Database postgresql, OCR עברית + אנגלית.
- ✅ נוצרו ב-Gmail התוויות Invoice/DRY-RUN, Detected, Forwarded, Review, Not-Invoice, Error, New-Supplier. הסקריפט המקומי מוסיף Invoice/Saved.
- ✅ **בדיקה מקצה לקצה עברה:** רן שלח לעצמו חשבונית (`...ZTAG-0009.pdf`). היא סומנה **Invoice/Review + Invoice/DRY-RUN** (ודאות בינונית) והגיעה התראה `[Invoice Automation] ⚠️ לבדיקה – Ran Azoulay`.
- ✅ הסקריפט המקומי הותקן (CHECK OK, המשימה המתוזמנת נוצרה).
- ✅ דוח Excel יומי ב-18:00 נשלח ל-raniazoulay@gmail.com.

## פתוח / הצעד הבא

1. **SAVE_REVIEW:** הוצע לרן לשנות ב-`C:\InvoiceSaver\saver_config.env` את `SAVE_REVIEW=true`, כדי שגם חשבוניות "לבדיקה" יישמרו (לתת-תיקייה `לבדיקה`). **לא אושר שבוצע.** בלי זה, חשבונית הבדיקה ZTAG-0009 לא נשמרת.
2. **למה ZTAG-0009 קיבלה Review ולא Detected:** ביקשתי מרן צילום של מייל ההתראה (ציון + סיבה). **לא התקבל.** אם צריך, לכוונן חוקים או ספים.
3. **תקופת DRY RUN (7 ימים):** לעקוב אחרי הדוחות היומיים (Would Forward, Possible Invoice, Errors).
4. **מעבר ל-Production (ידני בלבד, רק כשרן מאשר):** ב-Railway להוסיף `TARGET_GMAIL_ACCOUNT` (חייב להיות שונה מ-raniazoulay@gmail.com) ולשנות `DRY_RUN=false`, `AUTO_FORWARD_ENABLED=true`, `PRODUCTION_CONFIRMATION=true`. **המערכת לעולם לא עוברת לבד.**
5. אופציונלי: `BACKFILL_DAYS=7` לסריקת השבוע האחרון (אף פעם לא מעביר). `RULES_ONLY_AUTO_FORWARD` כגיבוי אם נגמר קרדיט ה-AI: הוצע, לא מומש.
6. אופציונלי: מיזוג הענף ל-main או PR. לא התבקש.

## היסטוריית בנייה (commits בענף)

1. בסיס המערכת: Gmail API, זיהוי PDF/DOCX/DOC + OCR, חוקים + AI, Decision Engine, SafetyGuard, DB, Excel, scheduler, `/health`, Docker, README.
2. תיקונים מבדיקת סוכן: אין העברה כפולה (sha256), שליחה בלי retry, אזור זמן בדוחות, חלון דוח של 24 שעות שמסתיים ב-18:00.
3. Railway Postgres: קריסה בעלייה, כי SQLAlchemy 2.1 מחפש psycopg3. תוקן על ידי נרמול ל-`postgresql+psycopg2://`.
4. דפי `/`, `/privacy`, `/terms` (EN + HE), כדי ש-Google יאפשר לפרסם את האפליקציה.
5. הודעות שגיאה ברורות ל-Gmail auth (`invalid_grant`, `invalid_client`, זיהוי `< >` ורווחים).
6. מייל התראה לכל חשבונית (`NOTIFY_DETECTIONS`), עמודה `notified_at`, מיגרציה אוטומטית.
7. `local_saver/`: סקריפט Windows + installer + `run_now.bat` + README בעברית.
- **בדיקות:** 106 עוברות, ruff ו-mypy נקיים. סוכן בדיקה נתן GO לכל שינוי.

## לקחים ממהלך ההתקנה (כדי לא לחזור עליהם)

- רן צריך הוראות צעד אחר צעד עם צילומי מסך, ולכתוב לו בעברית.
- **לפני כל שינוי קוד: להסביר לרן מה אעשה ולקבל אישור.** אחרי כל שינוי: להריץ סוכן בדיקה (סקיל agents-always, פתיחה במשפט "היי רן אני מתחיל עם התתי סוכנים את המשימה").
- בדוגמאות לערכים **לא להשתמש ב-`< >`**. רן העתיק אותם לתוך הערכים.
- OAuth Playground מאפס את ההגדרות בכל טעינה. להקפיד על Use your own credentials ועל scope מדויק `https://www.googleapis.com/auth/gmail.modify` (הייתה טעות הקלדה "modif").
- להעתיק את **Refresh token** (מתחיל ב-`1//`), ולא את Authorization code (`4/`) או את Access token (`ya29.`).
- רן שלח פעם Refresh token בצ'אט. הומלץ לבטל ולהחליף אותו. **לעולם לא לבקש מפתחות בצ'אט.**
- Claude בסביבת הענן **לא יכול לגשת ל-Railway** (הרשת חסומה, אין טוקן), ולכן רן מבצע ב-UI ושולח צילומים.

## אפליקציית SaaS לכמה לקוחות (נבנתה 2026-09-28)

המטרה של רן: למכור את המערכת. כל לקוח (עסק) מקבל לינק, נרשם כמנהל ומוסיף עובדים. כל עובד מחבר את ה-Gmail שלו, והמנוע רץ על כל תיבה.

- **קוד:** `src/saas/` (api, engine, queries, security, google_oauth, drive, bootstrap, models) ו-`src/web/app.html` (האפליקציה). בדיקות: `tests/test_saas.py`.
- **כתובות:** `/app` (האפליקציה), `/login`, `/signup?t=` (לקוח חדש), `/join?t=` (עובד), `/setup?t=` (מנהל מערכת, פעם אחת). API תחת `/api/...`. חזרת OAuth: `/oauth/google/callback`.
- **תפקידים:** מנהל מערכת TotanRomi (רן), מנהל עסק (רואה את כל העובדים, דוחות, הגדרות, הזמנות), עובד (רק התיבות שלו).
- **הקמת מנהל המערכת:** בעלייה הראשונה נשלח ל-SOURCE_GMAIL_ACCOUNT מייל עם קישור חד-פעמי `/setup` (בתוקף 7 ימים). ממסך "לקוחות TotanRomi" אפשר ללחוץ "יצירת העסק שלי". הקישור לעולם לא נכתב ללוגים. אם המייל לא נשלח: `python -m src.main admin-link` מדפיס קישור חדש.
- **אבטחה (אחרי סקירה):** חיבור Gmail קשור לדפדפן ולמשתמש שהתחילו אותו. שינוי כתובת רואה החשבון מכבה את מצב הייצור עד אישור מחדש של מנהל המערכת. קישורי הזמנה חד-פעמיים באופן אטומי. יציאה מבטלת את ה-session. ייצוא Excel מנטרל נוסחאות. `/health` מציג רק את החשבון המקורי. אם חשבון ה-env חובר באפליקציה, ה-watcher הישן נעצר לתמיד (גם אם התיבה מושהית), וגם במקרה של שגיאה.
- **ידוע, לא דחוף:** `message_id` ייחודי בכל המערכת (לא לכל תיבה). מזהי Gmail כמעט לא מתנגשים; לשקול מפתח (mailbox_id, message_id) בעתיד.
- **חיבור Gmail:** דרך 1 = אפליקציית Google המשותפת (ה-Client מ-GMAIL_CLIENT_ID/SECRET, עד 100 תיבות בסך הכל, עם מסך אזהרה). דרך 2 = פרויקט Google של הלקוח (Client ID/Secret במסך הגדרות של הלקוח; ל-Workspace: Internal, ללא הגבלה). Refresh tokens נשמרים מוצפנים.
- **Drive:** חשבוניות נשמרות ב-Drive של בעל התיבה, בתיקייה `TotanRomi Invoices/YYYY-MM` (ו"לבדיקה" אם מופעל). הרשאה drive.file בלבד.
- **רואה חשבון:** כתובת אחת לכל ארגון (מסך הגדרות).
- **בטיחות:** העברה ללקוח דורשת גם `production_enabled` בארגון (רק מנהל מערכת, עם הקלדת PRODUCTION) וגם שלושת מתגי ה-ENV. ברירת מחדל: DRY RUN.
- **החשבון המקורי של רן:** ממשיך לרוץ כמו קודם מה-ENV. כשרן מחבר את אותה תיבה באפליקציה, המנוע הישן נעצר עליה אוטומטית, והמיילים הישנים משויכים לעסק שלו.
- **צעדים ידניים שרן צריך לעשות ב-Google Cloud (פרויקט "GMAIL invoice-automation"):** (1) להוסיף ל-OAuth Client את ה-Redirect URI `https://gmail-invoice-automation-production.up.railway.app/oauth/google/callback`; (2) להפעיל Google Drive API. בלי זה "חיבור Gmail" באפליקציה ייכשל.
- **פתוח:** Office 365 (שלב 3), תשלום ומנויים (שלב 4), מייל דוח יומי לכל ארגון, ייבוא נתונים היסטוריים.
