# Gmail Invoice Automation

This system finds supplier invoices that arrive in your main Gmail account, reads the attached files, and logs every decision. In **production mode** it forwards invoices it is confident about to a second Gmail account.

> **It starts in DRY RUN mode by default.** In DRY RUN it analyses, labels, logs and reports, but it never forwards, sends, copies, deletes or modifies a supplier email. Switching to production is always manual (see [Production](#12-production)).

---

## 1. What the system does

```
Gmail ──► new email detected (Pub/Sub push or polling)
      ──► attachments (PDF / DOC / DOCX; images only if the filename looks like an invoice)
      ──► text extraction  ──► OCR (Hebrew + English) if the PDF has no text layer
      ──► Rule engine score + AI classification (JSON, validated)
      ──► Final confidence = AI_WEIGHT·AI + RULE_WEIGHT·Rules
      ──► Decision:  ≥0.90 HIGH | 0.70–0.89 REVIEW | <0.70 NOT INVOICE
      ──► DRY RUN  → log DRY_RUN_WOULD_FORWARD, label Invoice/DRY-RUN   (no send)
          PRODUCTION → guarded forward to TARGET_GMAIL_ACCOUNT
      ──► Database (metadata only) ──► Gmail labels
      ──► 18:00 Asia/Jerusalem: Excel report + summary email to SOURCE_GMAIL_ACCOUNT
```

## 2. Architecture

```
src/
  config/settings.py          environment configuration + safety switches
  gmail/auth.py               OAuth 2.0 refresh-token credentials (auto refresh)
  gmail/client.py             Gmail API wrapper (retry/backoff; no delete operations)
  gmail/reader.py             message → sender/subject/body/attachments
  gmail/watcher.py            Gmail Watch (Pub/Sub) + polling fallback, backfill
  gmail/labels.py             Invoice/* labels (only ever ADDED)
  gmail/forwarder.py          SafetyGuard + forwarding (all checks inside forward())
  documents/pdf.py            PDF text layer (pdfplumber → pypdf fallback)
  documents/ocr.py            Tesseract OCR (heb+eng) via pdf2image/poppler
  documents/word.py           DOCX (paragraphs, tables, headers, footers); DOC via antiword/LibreOffice
  documents/extractor.py      file-type detection, relevance filter, OCR retry
  classification/keywords.py  Hebrew/English keyword variants
  classification/rule_engine.py      indicator-based rule score
  classification/ai_classifier.py    Claude API, strict JSON validation + retry
  classification/decision_engine.py  final confidence, bands, whitelist
  classification/false_negative.py   "Possible Invoice" second check
  database/models.py, repository.py  SQLAlchemy (SQLite default, PostgreSQL ready)
  reports/data.py, excel.py, email_report.py   daily Excel + email
  scheduler/jobs.py           APScheduler with explicit timezone
  api/server.py               /health and /gmail/push
  processor.py                end-to-end pipeline for one email
  system_check.py             first-run SYSTEM CHECK
  main.py                     CLI
tests/                        63 tests (pytest)
scripts/get_refresh_token.py  one-time OAuth helper
```

## 3. Installation

Local (Python 3.11+):

```bash
cd invoice-automation
sudo apt-get install -y tesseract-ocr tesseract-ocr-heb poppler-utils antiword
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env        # then fill in the values
python -m src.main check    # SYSTEM CHECK
```

Docker:

```bash
cp .env.example .env        # fill in
docker compose up -d --build
docker compose logs -f
```

## 4. Google Cloud

1. Open https://console.cloud.google.com and create a project (or pick an existing one).
2. Go to **APIs & Services → Library** and enable the **Gmail API**.
3. Go to **APIs & Services → OAuth consent screen**. Choose "External", add your Gmail address as a **Test user**, and add the scope `https://www.googleapis.com/auth/gmail.modify`.
   - While the app is in "Testing" status, Google expires refresh tokens after 7 days. For long-term use, set the app to **In production**. For personal use with a sensitive scope you don't need verification, only the "unverified app" warning once.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**, choose type **Desktop app**, and download the JSON file as `client_secret.json`.

## 5. Gmail API

The system uses only the official Gmail API (no scraping, no IMAP passwords). Scope: `gmail.modify`, which covers read, add labels and send. The code never calls delete, trash, label removal or any body modification. Those methods don't exist in `gmail/client.py`.

Optional **Gmail Watch + Pub/Sub** (real-time):

1. Enable the **Cloud Pub/Sub API** and create a topic, e.g. `projects/<id>/topics/gmail-invoices`.
2. On that topic, grant **Pub/Sub Publisher** to `gmail-api-push@system.gserviceaccount.com`.
3. Create a **push** subscription with the endpoint `https://<your-host>/gmail/push?token=<PUBSUB_VERIFICATION_TOKEN>`.
4. Set `GMAIL_PUBSUB_TOPIC` and `PUBSUB_VERIFICATION_TOKEN` in `.env`.

The watch is renewed daily. Polling (`POLL_INTERVAL_SECONDS`, default 60) **always** runs as a fallback, so if Pub/Sub isn't configured or can't reach your server, emails are still picked up. `/health` shows `gmail_watch` as `NOT CONFIGURED`, `REGISTERED … NOT VERIFIED`, or `… VERIFIED` after the first real push arrives.

## 6. OAuth

```bash
python scripts/get_refresh_token.py client_secret.json
```

Sign in with the **SOURCE** account, then copy `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` into `.env`. No password is ever stored. The access token is refreshed automatically by `google-auth`.

## 7. AI setup

Set `AI_API_KEY` (Anthropic API key) and optionally `AI_MODEL` (default `claude-sonnet-5`). The AI must return a single JSON object. It is validated with pydantic (types, confidence 0–1), and malformed JSON is retried with exponential backoff.

If the AI isn't configured or fails, the system falls back to **rules only**, and the score is capped at 0.89. That means **nothing is auto-forwarded without an AI opinion**. Such emails go to Review.

## 8. OCR

This uses Tesseract with `heb+eng` (`OCR_LANGUAGES`). OCR runs only when a PDF has fewer than `MIN_TEXT_CHARS_FOR_PDF` (50) alphanumeric characters in its text layer. Images such as `signature.png`, `logo.jpg` or `tracking.gif` are never OCR'd. An image is only processed if its filename looks invoice-related (e.g. `invoice_scan.jpg`). OCR failures are retried with backoff (1, 2, 4 s…), then the attachment is marked as an ERROR.

## 9. Database

The default is `sqlite:///data/invoices.db`. For PostgreSQL:

```
DATABASE_URL=postgresql+psycopg2://invoices:invoices@postgres:5432/invoices
docker compose --profile postgres up -d
```

Tables: `emails` (message_id, thread_id, sender, subject, received/processed timestamps, status, scores), `attachments` (attachment_id, filename, mime_type, sha256, size, processed), `classifications` (is_invoice, confidence, type, supplier, number, dates, subtotal, VAT, total, currency, reason), `forwards` (forwarded, timestamp, target_email, target_message_id), and `system_state` (monitoring counters).

**Idempotency and duplicates:**
- Each Gmail `message_id` is processed once. Emails already in a final status are skipped. Emails in ERROR are retried up to `MAX_PROCESSING_ATTEMPTS`.
- Attachments are deduplicated by SHA-256. Identical content is never re-extracted or re-sent to the AI.
- A forward is reserved in the DB (`SENDING`) **before** the send call. A message with any forward row is never sent again, even after a crash. If the same invoice file (same SHA-256) arrives in a second email, that email goes to Review instead of being forwarded again.

## 10. Environment variables

See `.env.example` for the full list. The key ones:

| Variable | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `true` | Simulation only |
| `AUTO_FORWARD_ENABLED` | `false` | Production switch 2 |
| `PRODUCTION_CONFIRMATION` | `false` | Production switch 3 |
| `DRY_RUN_DAYS` | `7` | Length of the evaluation period, used for reminders only; it never switches mode |
| `INVOICE_AUTO_FORWARD_THRESHOLD` | `0.90` | HIGH band |
| `REVIEW_THRESHOLD` | `0.70` | REVIEW band |
| `AI_WEIGHT` / `RULE_WEIGHT` | `0.70` / `0.30` | Final-confidence weights |
| `BACKFILL_DAYS` | `0` | Scan the last N days on startup |
| `BACKFILL_FORWARD_ENABLED` | `false` | Allow forwarding of backfilled emails |
| `SUPPLIER_WHITELIST_ENABLED` / `SUPPLIER_WHITELIST` | `false` / empty | e.g. `@supplier.co.il,billing@x.com` |
| `MAX_ATTACHMENT_SIZE_MB` | `25` | Larger attachments are skipped as errors |
| `RETRY_MAX_ATTEMPTS` / `RETRY_BASE_DELAY_SECONDS` | `5` / `1` | Backoff of 1, 2, 4, 8, 16 s |
| `STORE_DOCUMENT_TEXT` | `false` | Keep full document text in the DB (not recommended) |

## 11. DRY RUN

With `DRY_RUN=true` (the default), the system may read Gmail, download attachments, parse PDF and Word files, run OCR and AI, write to the DB, create Excel files and **add labels**. It never forwards, sends or copies to the target, and never deletes or modifies the original email.

- High-confidence invoices are logged as `DRY_RUN_WOULD_FORWARD` and labelled `Invoice/Detected` + `Invoice/DRY-RUN`.
- The daily Excel shows **Would Forward** next to **Actually Forwarded** (`NO – DRY RUN`). `Actually Forwarded` is always 0.
- The daily email starts with `⚠ DRY RUN MODE — No emails were forwarded.` and shows "Dry-run evaluation day X of 7".
- After `DRY_RUN_DAYS`, the report says the period is complete, but the system **remains in DRY RUN**.

The only email the system sends in DRY RUN is the daily report, sent to `SOURCE_GMAIL_ACCOUNT` (yourself). It contains only the generated Excel file, never a supplier email or invoice file.

**Safety Guard** (`gmail/forwarder.py`): `Forwarder.forward()` itself checks, on every call and again right before the network call, that:

```
DRY_RUN is False  AND  AUTO_FORWARD_ENABLED is True  AND  PRODUCTION_CONFIRMATION is True
AND target configured (and different from source)  AND  (not backfill OR BACKFILL_FORWARD_ENABLED)
```

If any of these fails, the send API is never reached. This holds even when `forward()` is called directly from buggy code (`tests/test_safety.py::test_dry_run_forward_function_cannot_send_even_when_called_directly`).

**Recommended evaluation routine (7 days):**
1. Run in DRY RUN with `BACKFILL_DAYS=7` for immediate data (backfill never forwards).
2. Each evening, open the Excel file:
   - **REPORT**: rows in green are "would forward", orange are Review or Possible Invoice, red are errors.
   - **QUALITY**: detection rate, high-confidence %, review %, possible false negatives, errors %.
   - Check every `Possible Invoice = YES` row, because these are potential misses.
3. Adjust the thresholds or weights if needed.

## 12. Production

Edit `.env` manually and set **all three** switches:

```
DRY_RUN=false
AUTO_FORWARD_ENABLED=true
PRODUCTION_CONFIRMATION=true
```

Then restart (`docker compose up -d` or re-run `python -m src.main run`). Any other combination means **no forwarding**.

In production, emails with final confidence ≥ `INVOICE_AUTO_FORWARD_THRESHOLD` are forwarded as a new message (`Fwd: <subject>`, original body and attachments) to `TARGET_GMAIL_ACCOUNT`. The original stays untouched in the source mailbox, with only the `Invoice/Forwarded` label added. The DB stores `forwarded`, `forward_timestamp`, `target_email` and `target_message_id`. The last one is the id of the sent copy in the source account's Sent folder.

To go back to simulation, set `DRY_RUN=true` and restart.

## 13. Backfill

```bash
python -m src.main backfill --days 7     # one-off
# or BACKFILL_DAYS=7 in .env → runs once at service start
```

Backfilled emails are never forwarded unless `BACKFILL_FORWARD_ENABLED=true` **and** production is fully enabled.

## 14. Scheduler

APScheduler runs with an explicit `TIMEZONE` (default `Asia/Jerusalem`). It does not depend on the server's timezone.

- Polling every `POLL_INTERVAL_SECONDS`.
- Daily report at `DAILY_REPORT_TIME` (18:00). The Excel file is saved to `reports_out/invoice_report_YYYY-MM-DD.xlsx` and emailed with the subject `Daily Invoice Automation Report – YYYY-MM-DD`.
- Gmail watch renewal daily (when Pub/Sub is configured).

Manual report: `python -m src.main report [--date 2026-09-27] [--no-send]`.

Excel sheets: **SUMMARY**, **REPORT** (all required columns), **SUPPLIERS**, **QUALITY**.

## 15. Troubleshooting

| Symptom | Fix |
|---|---|
| `Gmail: NOT CONFIGURED` | Fill in the 3 `GMAIL_*` values (step 6). |
| `Gmail: ERROR RefreshError` | The refresh token was revoked or expired (Testing-mode apps expire after 7 days). Re-run `get_refresh_token.py`. |
| `Gmail: ERROR token belongs to …` | The token was created with the wrong account. Sign in with `SOURCE_GMAIL_ACCOUNT`. |
| `AI: ERROR AuthenticationError` | Invalid `AI_API_KEY`. |
| Everything goes to Review | Check whether AI is NOT CONFIGURED or failing (rules-only scores are capped at 0.89). |
| Scanned PDFs are errors | Check that `OCR: OK` in the check output. Install `tesseract-ocr tesseract-ocr-heb poppler-utils`. |
| `.doc` = `LIMITATION` | Install `antiword` or LibreOffice. |
| Watch shows NOT VERIFIED | Check the push subscription URL and token, and the publisher permission for `gmail-api-push@system.gserviceaccount.com`. Polling still works in the meantime. |
| Health | `curl localhost:8080/health` |

## 16. Security and privacy

- No passwords are stored. OAuth refresh-token flow only. `.env` is git-ignored.
- Logs never print API keys, OAuth tokens or document contents. A redaction filter masks token patterns and configured secrets as a safety net.
- The DB stores **metadata only**: no email body, and no document text unless `STORE_DOCUMENT_TEXT=true`.
- The original email is never deleted, moved or modified. Labels are only added.
- `/gmail/push` requires `PUBSUB_VERIFICATION_TOKEN` and uses a constant-time comparison.

**Data sent to the AI provider (Anthropic)**, only for emails that have a relevant PDF/DOC/DOCX attachment with extractable text:
sender name, sender email, subject, the first 2,000 characters of the email body, the attachment filename, the text-extraction method, and the first `AI_MAX_DOC_CHARS` (8,000) characters of the extracted or OCR text. Emails without such attachments are never sent to the AI. Duplicate attachments (same SHA-256) are not re-sent.

## 17. Deployment

- **Docker / VPS:** `docker compose up -d --build`. Mount `data/` and `reports_out/` (already set in `docker-compose.yml`). Expose port 8080 only if you use Pub/Sub push, behind HTTPS.
- **Cloud Run / Railway / Fly:** use the Dockerfile. Keep **one** instance, always on (min instances = 1), because the scheduler runs in-process. Use PostgreSQL through `DATABASE_URL` so state survives redeploys.
- Tests, lint and type checks: `./scripts/run_tests.sh`.

## CLI

```
python -m src.main check          # SYSTEM CHECK
python -m src.main run            # service (poller + scheduler + /health)
python -m src.main process-once   # single poll cycle
python -m src.main backfill --days 7
python -m src.main report [--date YYYY-MM-DD] [--no-send]
```

## Known limitations

- Legacy `.doc` extraction is best effort (antiword or LibreOffice). If neither is installed, `.doc` files are marked as ERROR (`LIMITATION`) rather than silently skipped.
- OCR is limited to the first `OCR_MAX_PAGES` (5) pages of a scanned PDF.
- Emails whose only attachments are irrelevant (e.g. a logo) are counted as "no attachment". The Possible Invoice check still runs on their subject, sender and body.
- Gmail Watch delivery can only be verified once a real push notification arrives.
