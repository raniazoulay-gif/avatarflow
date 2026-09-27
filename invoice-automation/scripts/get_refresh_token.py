"""One-time helper: obtain a Gmail OAuth refresh token.

Usage:
  1. Create an OAuth client (type "Desktop app") in Google Cloud Console and
     download it as client_secret.json.
  2. python scripts/get_refresh_token.py client_secret.json
  3. Sign in with the SOURCE Gmail account in the browser window.
  4. Copy the printed values into .env (never commit .env).
"""

from __future__ import annotations

import json
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1
    flow = InstalledAppFlow.from_client_secrets_file(sys.argv[1], SCOPES)
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    with open(sys.argv[1]) as f:
        info = json.load(f)
    client = info.get("installed") or info.get("web") or {}
    print("\nAdd these to your .env file (keep them secret):\n")
    print(f"GMAIL_CLIENT_ID={client.get('client_id', '')}")
    print(f"GMAIL_CLIENT_SECRET={client.get('client_secret', '')}")
    print(f"GMAIL_REFRESH_TOKEN={creds.refresh_token}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
