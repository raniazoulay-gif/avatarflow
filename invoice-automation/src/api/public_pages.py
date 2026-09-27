"""Public home, privacy-policy and terms pages required by the Google OAuth
consent screen (Branding) to publish the app. Static content only - nothing
about mailbox contents or system state is exposed here.
"""

from __future__ import annotations

import html

_STYLE = """
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; max-width: 760px;
         margin: 0 auto; padding: 24px 16px 48px; line-height: 1.6; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 1.6em; }
  nav a { margin-inline-end: 16px; }
  .he { direction: rtl; text-align: right; border-top: 1px solid #8884; margin-top: 32px;
        padding-top: 16px; }
</style>
"""


def _page(title: str, body: str) -> str:
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<title>{html.escape(title)}</title>{_STYLE}</head><body>"
        "<nav><a href='/'>Home</a><a href='/privacy'>Privacy Policy</a>"
        "<a href='/terms'>Terms of Service</a></nav>"
        f"{body}</body></html>"
    )


def _contact(email: str) -> str:
    if not email:
        return "the owner of this deployment"
    e = html.escape(email)
    return f"<a href='mailto:{e}'>{e}</a>"


def home_page(contact_email: str) -> str:
    return _page("Invoice Automation", f"""
<h1>Invoice Automation</h1>
<p>Invoice Automation is a private, single-user tool. It reads new emails in its owner's
Gmail account, detects supplier invoices in PDF / Word attachments, labels them, produces a
daily Excel report and - only when the owner explicitly enables it - forwards detected
invoices to the owner's bookkeeping mailbox.</p>
<p>It is not a public service and cannot be used by other people.</p>
<p>Contact: {_contact(contact_email)}</p>
<div class="he">
<h1>אוטומציית חשבוניות</h1>
<p>כלי פרטי לשימוש של משתמש יחיד: קורא מיילים חדשים בחשבון ה-Gmail של הבעלים, מזהה חשבוניות
בקבצים מצורפים, מתייג אותן, מפיק דוח Excel יומי, ומעביר חשבוניות לתיבת הנהלת החשבונות רק כאשר
הבעלים הפעיל זאת במפורש.</p>
</div>
""")


def privacy_page(contact_email: str) -> str:
    return _page("Privacy Policy - Invoice Automation", f"""
<h1>Privacy Policy</h1>
<p>Last updated: 2026-09-27</p>
<p>Invoice Automation ("the app") is a private tool operated by and for a single Gmail account
owner. This policy explains what Google user data the app accesses and how it is handled.</p>

<h2>Data the app accesses</h2>
<ul>
  <li>Email metadata of new messages: sender name and address, subject, date, message and thread IDs.</li>
  <li>Email body text and attachments (PDF, DOC, DOCX, and invoice-named images) - read only to
      decide whether a message contains an invoice.</li>
</ul>

<h2>How the data is used</h2>
<ul>
  <li>To detect invoices and extract invoice details (supplier, number, dates, amounts, VAT).</li>
  <li>To add "Invoice/..." labels to the owner's messages. Original messages are never deleted
      or modified.</li>
  <li>To send the owner a daily report email to their own address.</li>
  <li>Only if the owner explicitly enables production mode: to forward detected invoices to a
      mailbox chosen by the owner.</li>
</ul>

<h2>Storage and retention</h2>
<p>The app stores metadata in a private database: sender, subject, dates, file names, file
hashes, and classification results (extracted invoice fields such as supplier, number, dates,
amounts and VAT, plus the short reasoning for the decision). Full email bodies are not stored.
Full document text is not stored by default; the owner may optionally enable storing extracted
attachment text for troubleshooting. The owner can delete the database at any time.</p>

<h2>Sharing</h2>
<p>Data is not sold, rented or used for advertising, and is not shared with anyone except the
hosting provider that runs the app and an AI service provider (Anthropic), used solely to
classify documents. For emails that have a PDF/DOC/DOCX attachment, Anthropic receives: the
sender name and address, the subject, the attachment file name, up to about 2,000 characters of
the email body and a truncated excerpt of the attachment text. Nothing is sent to the AI
provider for emails without such an attachment. Anthropic does not use API data for model
training.</p>

<h2>Google API Services User Data Policy</h2>
<p>The app's use and transfer of information received from Google APIs adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services
User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Revoking access</h2>
<p>Access can be revoked at any time at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>

<h2>Contact</h2>
<p>{_contact(contact_email)}</p>

<div class="he">
<h1>מדיניות פרטיות</h1>
<p>האפליקציה היא כלי פרטי של בעל חשבון Gmail יחיד. היא קוראת מטא-דאטה, גוף מייל וקבצים מצורפים
של מיילים חדשים רק כדי לזהות חשבוניות; מוסיפה תוויות ולא מוחקת או משנה מיילים; שומרת מטא-דאטה בלבד
(ללא תוכן מלא של מיילים; תוכן מסמכים נשמר רק אם הבעלים הפעיל זאת במפורש); ואינה מוכרת או משתפת
מידע, מלבד ספק האחסון וספק AI (Anthropic) המקבל - רק למיילים עם קובץ PDF/DOC/DOCX - שולח, נושא,
שם קובץ, עד כ-2,000 תווים מגוף המייל וקטע מקוצר מטקסט הקובץ, לצורך סיווג בלבד.
ניתן לבטל את הגישה בכל עת ב-myaccount.google.com/permissions.</p>
</div>
""")


def terms_page(contact_email: str) -> str:
    return _page("Terms of Service - Invoice Automation", f"""
<h1>Terms of Service</h1>
<p>Last updated: 2026-09-27</p>
<p>Invoice Automation is a private tool for its owner's personal/business use only. It is
provided as-is, without warranty. Invoice detection is automated and may be wrong; the owner
remains responsible for reviewing reports and for their bookkeeping. No access is offered to
third parties.</p>
<p>Contact: {_contact(contact_email)}</p>
""")
