---
name: invoices-memory
description: >
  תזכורת "איפה הפסקנו" לפרויקט אוטומציית החשבוניות של רן (Gmail Invoice Automation):
  זיהוי חשבוניות ב-Gmail, שרת ב-Railway (פרויקט "GMAIL invoice-automation" + Postgres),
  AI Haiku, מצב DRY RUN, התראות מייל, דוח Excel יומי ושמירה מקומית ב-C:\InvoiceSaver.
  השתמש בסקיל הזה בכל פעם שהמשתמש כותב "חשבוניות", "חשבונית", "invoices",
  "אוטומציית חשבוניות", "gmail invoice", "invoice automation", "בוא נחזור לחשבוניות",
  "מה המצב עם החשבוניות", או כל פנייה למערכת זיהוי החשבוניות בלי הקשר מיידי בשיחה —
  גם אם לא ביקש "תזכורת" במפורש. אם השיחה כבר באמצע עבודה על החשבוניות, אין צורך להפעיל שוב.
---

# Invoices Memory – חזרה לנקודה שבה הפסקנו

## למה הסקיל קיים
רן בנה עם Claude מערכת לזיהוי חשבוניות ב-Gmail, ועובד במקביל על כמה פרויקטים.
ההקשר של שיחות קודמות לא נשמר. קובץ הזיכרון של הפרויקט הוא המקור היחיד למה שנעשה.
לכן תמיד קוראים אותו ולא מנחשים.

## שלבי ביצוע

### 1. קרא את קובץ הזיכרון (לפי הסדר, הראשון שנמצא)
1. **בסביבת ענן או ריפו:** הקובץ `invoice-automation/PROJECT_MEMORY.md` בריפו
   `raniazoulay-gif/avatarflow`, **בענף `claude/gmail-invoice-detection-lsqsrg`**.
   - אם הריפו מקומי: `git fetch origin claude/gmail-invoice-detection-lsqsrg` ואז
     `git show origin/claude/gmail-invoice-detection-lsqsrg:invoice-automation/PROJECT_MEMORY.md`
   - אחרת: דרך כלי GitHub, `get_file_contents` עם ה-ref של הענף.
2. **במחשב של רן:** `C:\Users\Ran Azoulay\.claude\projects\C--Users-Ran-Azoulay\memory\invoice_automation.md`
   (אם קיים).
3. **אם אף אחד לא נמצא:** השתמש בתקציר הגיבוי שבסוף הסקיל, ואמור שזה גיבוי ולא הקובץ העדכני.

### 2. הצג לרן תקציר בעברית, במבנה הזה

```
📍 חשבוניות – איפה הפסקנו

🟢 מצב המערכת: <DRY RUN / Production>, <מה מחובר>
✅ הושלם לאחרונה: <2–4 נקודות>
⏳ פתוח / הצעד הבא: <הפריטים מ"פתוח / הצעד הבא", בסדר עדיפות>
🔗 גישה: Railway "GMAIL invoice-automation" | ענף claude/gmail-invoice-detection-lsqsrg | C:\InvoiceSaver
```

אחרי התקציר שאל: **"מאיפה ממשיכים?"**, והצע את הצעד הפתוח הראשון.

### 3. כללי עבודה עם רן בפרויקט הזה
- עברית, צעד אחר צעד, עם בקשת צילום מסך אחרי כל שלב ב-UI.
- **לפני כל שינוי קוד:** להסביר מה ייעשה ולקבל אישור. אחרי כל שינוי: סוכן בדיקה (agents-always).
- **לעולם לא לבקש מפתחות, טוקנים או סיסמאות בצ'אט.** הם נכנסים רק ל-Railway או ל-`saver_config.env`.
- בדוגמאות לערכים לא להשתמש ב-`< >`.
- **המעבר ל-Production ידני בלבד:** `DRY_RUN=false`, `AUTO_FORWARD_ENABLED=true`,
  `PRODUCTION_CONFIRMATION=true` ו-`TARGET_GMAIL_ACCOUNT` (שונה מ-raniazoulay@gmail.com).
  לעולם לא לבצע אותו בלי בקשה מפורשת של רן.
- **בסוף כל סשן:** לעדכן את `PROJECT_MEMORY.md` בענף, ולבצע commit ו-push.

## תקציר גיבוי (נכון ל-2026-10-01)
- **השרת:** רץ ב-Railway ב-DRY RUN. Gmail ו-AI (Haiku) מחוברים, Postgres תקין. דוח יומי ב-18:00.
- **אפליקציית SaaS (TotanRomi Invoice AI):** `/app` בכתובת ה-Railway. הרשמה עצמית לעסקים, מנהל מוסיף
  עובדים עם סיסמה ראשונית, כל עובד מחבר Gmail, סריקה לפי טווח שהעובד בוחר, צפייה בחשבונית בתוך
  האפליקציה, "העבר לגורם מטפל", כפילויות, סינון מסמכים שאינם חשבונית, בדיקה חוזרת. רן = מנהל מערכת.
- **השמירה המקומית:** מותקנת ב-`C:\InvoiceSaver` (Task Scheduler כל 10 דקות).
- **פתוח:** בדיקות עם העובדת סימונה, חשבוניות בקישור/גוף מייל, Office 365, תשלומים.
