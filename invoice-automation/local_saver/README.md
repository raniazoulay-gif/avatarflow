# Invoice Saver – שמירת חשבוניות לתיקייה במחשב

הסקריפט רץ **במחשב שלך** ושומר כל חשבונית שהמערכת בענן זיהתה (תווית `Invoice/Detected` ב-Gmail) לתיקייה:

```
<SAVE_DIR>\2026-09\2026-09-27_שם השולח_שם הקובץ המקורי.pdf
```

- רץ אוטומטית **כל 10 דקות** וגם **בכניסה ל-Windows** (Task Scheduler), ברקע וללא חלון.
- כל מייל נשמר **פעם אחת**. אחרי השמירה מתווספת לו ב-Gmail התווית `Invoice/Saved`.
- הסקריפט **רק קורא ושומר**. אין בו קוד שיכול לשלוח, להעביר או למחוק מיילים.
- אם המחשב היה כבוי, בהרצה הבאה יישמר כל מה שהצטבר.

## התקנה (פעם אחת, כ-5 דקות)

1. **Python**: אם אין לך, התקן מ-https://www.python.org/downloads/ (גרסה 3.11 ומעלה) וסמן ✅ **Add python.exe to PATH**.
2. **העתק את התיקייה** `local_saver` למקום קבוע במחשב, לדוגמה `C:\InvoiceSaver`.
   מומלץ **לא** לשים אותה בתוך OneDrive, כי קובץ ההגדרות מכיל את מפתחות ה-Gmail.
3. פתח את התיקייה, לחץ על שורת הכתובת של הסייר, כתוב `powershell` ולחץ Enter. בחלון שנפתח הרץ:
   ```
   powershell -ExecutionPolicy Bypass -File install_windows.ps1
   ```
4. ייפתח Notepad עם `saver_config.env`. מלא את 3 הערכים (אותם ערכים כמו ב-Railway), שמור וסגור.
5. ההתקנה בודקת את החיבור ל-Gmail ואת התיקייה, יוצרת את המשימה המתוזמנת ומריצה שמירה ראשונה.

## שימוש

| מה | איך |
|---|---|
| הרצה ידנית עם פלט על המסך | לחיצה כפולה על `run_now.bat` |
| יומן פעולות | `invoice_saver.log` באותה תיקייה |
| שמירה גם של "לבדיקה" | ב-`saver_config.env`: `SAVE_REVIEW=true` (נשמר לתת-תיקייה `לבדיקה`) |
| שינוי תיקיית היעד | ב-`saver_config.env`: `SAVE_DIR=...` |
| הסרת המשימה המתוזמנת | `powershell -ExecutionPolicy Bypass -File uninstall_windows.ps1` |

## תקלות

| הודעה ביומן | פתרון |
|---|---|
| `Gmail login failed: RefreshError` | אחד משלושת המפתחות ב-`saver_config.env` שגוי או בוטל |
| `Logged in as ..., expected ...` | ה-Refresh token שייך לחשבון אחר מ-`GMAIL_ACCOUNT` |
| `Label Invoice/Detected not found` | השירות בענן עוד לא רץ או עוד לא זיהה חשבונית |
| `Cannot write to ...` | התיקייה לא קיימת או שאין הרשאה. בדוק את `SAVE_DIR` |

## אבטחה

- `saver_config.env` נשאר רק במחשב שלך. אל תשתף אותו ואל תעלה אותו ל-OneDrive או ל-GitHub.
- הקבצים נשמרים כפי שהגיעו, בלי שינוי.
