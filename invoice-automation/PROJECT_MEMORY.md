# זיכרון פרויקט: Gmail Invoice Automation

> **קובץ המקור לסקיל "חשבוניות".** יש לעדכן אותו בסוף כל סשן עבודה.
> אין כאן מפתחות, טוקנים או סיסמאות, וגם אסור להוסיף אותם.
> עודכן לאחרונה: 2026-10-01 (אפליקציית ה-SaaS לכמה לקוחות פעילה ונבדקת עם לקוח ראשון)

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
- **מ-2026-09-28 רן ביקש "תעשה הכל בעצמך, בלי לבקש אישורים"**: מבצעים, מריצים סוכני סקירה, מתקנים ודוחפים, ומדווחים בסוף. (קודם: להסביר ולקבל אישור לפני שינוי קוד.) אחרי כל שינוי: להריץ סוכן בדיקה (סקיל agents-always, פתיחה במשפט "היי רן אני מתחיל עם התתי סוכנים את המשימה").
- בדוגמאות לערכים **לא להשתמש ב-`< >`**. רן העתיק אותם לתוך הערכים.
- OAuth Playground מאפס את ההגדרות בכל טעינה. להקפיד על Use your own credentials ועל scope מדויק `https://www.googleapis.com/auth/gmail.modify` (הייתה טעות הקלדה "modif").
- להעתיק את **Refresh token** (מתחיל ב-`1//`), ולא את Authorization code (`4/`) או את Access token (`ya29.`).
- רן שלח פעם Refresh token בצ'אט. הומלץ לבטל ולהחליף אותו. **לעולם לא לבקש מפתחות בצ'אט.**
- Claude בסביבת הענן **לא יכול לגשת ל-Railway** (הרשת חסומה, אין טוקן), ולכן רן מבצע ב-UI ושולח צילומים.

## אפליקציית SaaS לכמה לקוחות (נבנתה 2026-09-28 עד 2026-10-01)

המטרה של רן: למכור את המערכת לעסקים. כל עסק נרשם בעצמו, המנהל מוסיף עובדים, כל עובד מחבר את ה-Gmail שלו, והמנוע מזהה חשבוניות בכל תיבה. מותג: **TotanRomi Invoice AI** (אותו עיצוב כמו בסרטון: Rubik, Space Grotesk, Pacifico, גרדיאנט טורקיז-סגול, עברית RTL).

### איפה ומה
- **כתובת:** `https://gmail-invoice-automation-production.up.railway.app/app`. כל push לענף עולה אוטומטית ל-Railway (כ-5 דקות).
- **קוד:** `src/saas/` (api, engine, queries, security, google_oauth, drive, bootstrap, models) ו-`src/web/app.html` (אפליקציית דף-יחיד, JS ללא ספריות, כל טקסט דרך `esc()`). בדיקות: `tests/test_saas.py` (סה"כ כ-150 בדיקות עוברות, ruff + mypy נקיים).
- **דפים:** `/app`, `/login`, `/signup` (הרשמה פתוחה), `/forgot`, `/join?t=` ו-`/setup?t=` (ישנים, עדיין עובדים). חזרת OAuth: `/oauth/google/callback`.
- **טבלאות חדשות:** organizations, users, mailboxes, invites (גם קודי אימות 6 ספרות), email_views (מי ראה מה), manual_sends (העברה לגורם מטפל). עמודות חדשות ב-emails: org_id, mailbox_id, reviewed_by/at, duplicate_of, rechecks. מיגרציה אוטומטית קדימה בלבד.

### תפקידים והרשמה
- **מנהל מערכת (רן):** מסך "לקוחות TotanRomi": קישור הרשמה ללקוח, רשימת לקוחות, הפעלת העברה לרו"ח לכל לקוח (הקלדת PRODUCTION), השהיית לקוח. כל הכרטיסים לחיצים (רשימת כל התיבות, תיבות עם תקלה ופירוט, מסמכים לפי לקוח).
- **רן נרשם כ-"רן אזולאי בדיקה 1"** דרך /signup עם raniazoulay@gmail.com וקיבל אוטומטית גם הרשאת מנהל מערכת (המייל תואם ל-SOURCE_GMAIL_ACCOUNT והקוד הוכיח בעלות). עובדת בדיקה: סימונה (amnonazolay123@gmail.com).
- **מנהל עסק:** נרשם מ-/signup עם קוד אימות למייל (נשלח מתיבת המערכת raniazoulay@gmail.com). רואה את כל העובדים, דוחות, Excel, הגדרות (רו"ח אחד לכל עסק, סף, פרויקט Google משלו).
- **עובד:** המנהל מוסיף אותו במסך "עובדים", המערכת יוצרת סיסמה ראשונית (72 שעות) והודעה מוכנה להעתקה/וואטסאפ/מייל. בכניסה ראשונה חובה להחליף סיסמה ואז מועברים ישר ל"חיבור Gmail". עובד רואה רק את התיבה שלו, ולא רואה את סיבות ה-AI.
- **שכחתי סיסמה:** קוד למייל. מנהל יכול לאפס סיסמה לעובד (לא למנהל אחר).

### חיבור Gmail ושמירה
- דרך 1: אפליקציית Google המשותפת (GMAIL_CLIENT_ID/SECRET, עד 100 משתמשים, מסך "unverified app" → Advanced → Go to). דרך 2: פרויקט Google של הלקוח (מסך הגדרות).
- **רן ביצע ב-Google Cloud:** הוסיף redirect URI `.../oauth/google/callback` והפעיל Google Drive API (2026-09-29). בלי זה: redirect_uri_mismatch.
- חידוש גישה בלי scopes קבועים (תוקן invalid_scope כשמשתמש לא סימן Drive).
- Drive: `TotanRomi Invoices/YYYY-MM` ב-Drive של בעל התיבה (drive.file בלבד).

### סריקה
- בחיבור תיבה אין סריקת עבר אוטומטית; מעכשיו כל מייל חדש נבדק (כל 2 דקות).
- "סרוק עכשיו" פותח חלון: השעה האחרונה, היום, 7 ימים, 30 יום, החודש, החודש הקודם, 3/6 חודשים, שנה, או תאריכים חופשיים (עד שנתיים). רק התיבה של המשתמש. התקדמות חיה ופירוט בסוף (נמצאו / כבר טופלו / לא חשבונית / בלי קובץ).
- מיילים מלפני חיבור התיבה = היסטוריה, **לעולם לא נשלחים לרו"ח**. מיילים מאחרי החיבור מטופלים כמו הסריקה החיה.

### זיהוי וסיווג (שיפורים)
- **מסמכים דומים לחשבונית שאינם חשבונית** → "לא חשבונית": אישור תשלום, פוליסה/פרמיה/אישור ביטוח, הצעת מחיר, תעודת משלוח, דף חשבון, תלוש שכר, אישור ניכוי מס, אישור הזמנה, כרטיס טיסה/e-ticket, pro forma. חריג: אם המסמך קורא לעצמו חשבונית/קבלה/invoice/receipt (דוגמה: אישור תשלום AIG → לא חשבונית).
- **קבלה של ספק = חשבונית** (גם בלי מע"מ). מזהי ספק: מספר חברה, ח"פ/ע"מ עם גרשיים, בע"מ (עם גרשיים בלבד), עוסקים. PDF עברי הפוך נבדק גם בכיוון ההפוך (דוגמה: קבלת חברת החשמל).
- **כפילות:** אותו קובץ שכבר התקבל במייל אחר באותו עסק → סטטוס "כפילות" (לא בבדיקה, לא נשלח פעמיים, לא נשמר שוב ב-Drive), עם קישור למקורי.
- **בלי AI** (למשל נגמר קרדיט, כמו ב-27.9 כשרן טען 20$) המערכת מגיעה לכל היותר ל"בדיקה". מסמכים כאלה **נבדקים שוב אוטומטית** כשה-AI חוזר (עד 5 פעמים). כפתור **"בדיקה חוזרת"** בכל מסמך (לא נוגע במסמך שסומן ידנית או שנשלח, ולא מעביר לרו"ח).
- אפשר לתקן כל החלטה ידנית ("זו לא חשבונית" / "זו כן חשבונית") עד שהמסמך נשלח.

### מסך המסמכים
- דואר נכנס: עמודת עין (נצפה / לא נצפה, לכל משתמש בנפרד), מסננים: כל המסמכים, חשבוניות, לבדיקה, לא חשבונית.
- חלון מסמך: **החשבונית עצמה (PDF/תמונה) מוצגת בתוך האפליקציה**, נשלפת מ-Gmail ברגע הצפייה ולא נשמרת אצלנו; פתיחה במסך מלא, הורדה, פתיחה ב-Gmail.
- **"העבר לגורם מטפל":** שליחת הקובץ המקורי מה-Gmail של המשתמש עצמו לרו"ח / מנהל / כתובת קודמת / כתובת חדשה + הערה. תיעוד "הועבר לטיפול". עד 40 ליום. שליחה ידנית, לא קשורה ל-DRY RUN.
- הוסרו לבקשת רן: "התהליך האוטומטי", כפתורי כפויות/שגיאות/בלי קובץ. "התור שלי לבדיקה" שונה ל"מחכים להחלטה שלי" (מסמכים בין 70% ל-90%).
- כל כרטיסי לוח הבקרה לחיצים.

### אבטחה (נבדק בסוכני סקירה אחרי כל שינוי)
חיבור OAuth קשור לדפדפן ולמשתמש; שינוי כתובת רו"ח מכבה העברה עד אישור מחדש; קישורים וקודים חד-פעמיים ומוגבלי ניסיונות (נספר ב-DB); אי אפשר לתפוס את כתובת הבעלים; יציאה מבטלת session; Excel מנטרל נוסחאות; קבצים מוגשים רק לבעלי הרשאה, PDF מזוהה לפי תוכן, שאר הקבצים בהורדה עם sandbox; `/health` מציג רק את החשבון המקורי; קישור הקמת מנהל לא נכתב ללוגים (`python -m src.main admin-link`).

### בטיחות העברה
העברה אוטומטית לרו"ח של לקוח דורשת `production_enabled` בעסק (רק מנהל מערכת) **וגם** שלושת מתגי ה-ENV. כרגע הכול **DRY RUN**. המערכת לעולם לא עוברת לבד.

### החשבון המקורי של רן
אם raniazoulay@gmail.com מחובר באפליקציה, המנוע הישן נעצר עליו לתמיד והמיילים הישנים משויכים לעסק שלו.

### פתוח / הצעד הבא באפליקציה
1. לבדוק עם רן/סימונה: "בדיקה חוזרת" על חשבונית Anthropic ועל קבלת חברת החשמל; תצוגת PDF בתוך האפליקציה; "העבר לגורם מטפל" לעצמו.
2. חשבוניות שמגיעות כקישור או בגוף המייל (בלי קובץ) לא נבדקות. לשקול זיהוי מקישורים/גוף מייל.
3. Office 365 (שלב 3), תשלום ומנויים (שלב 4), דוח יומי לכל עסק.
4. ידוע, לא דחוף: `message_id` ייחודי בכל המערכת (לא לכל תיבה).
