#!/usr/bin/env python3
import sys
import json
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/adwords"]

def main():
    if len(sys.argv) < 3:
        print("Usage:")
        print("  python3 generate_refresh_token.py <CLIENT_ID> <CLIENT_SECRET>")
        sys.exit(1)

    client_id = sys.argv[1].strip()
    client_secret = sys.argv[2].strip()

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost:8085/", "http://127.0.0.1:8085/"]
        }
    }

    flow = InstalledAppFlow.from_client_config(
        client_config,
        scopes=SCOPES
    )

    try:
        # 1. Try local server flow on port 8085
        credentials = flow.run_local_server(
            port=8085,
            prompt="consent",
            access_type="offline",
            open_browser=False
        )
    except Exception as e:
        print("Local server notice:", e)
        credentials = flow.run_console()

    print("\n" + "="*70)
    print("✅ REFRESH TOKEN GENERATED SUCCESSFULLY:")
    print("="*70)
    print(credentials.refresh_token)
    print("="*70 + "\n")

if __name__ == "__main__":
    main()
