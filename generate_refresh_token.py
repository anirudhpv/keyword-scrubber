#!/usr/bin/env python3
import sys
from google_auth_oauthlib.flow import InstalledAppFlow

# Google Ads Scope
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
        }
    }

    flow = InstalledAppFlow.from_client_config(
        client_config,
        scopes=SCOPES,
        redirect_uri="urn:ietf:wg:oauth:2.0:oob"
    )

    auth_url, _ = flow.authorization_url(prompt="consent", access_type="offline")

    print("\n" + "="*70)
    print("📍 STEP 1: Open this URL in your browser and sign in with the")
    print("   Google Account that manages your Google Ads:")
    print("="*70 + "\n")
    print(auth_url)
    print("\n" + "="*70)
    print("📍 STEP 2: After approving, Google will give you an Authorization Code.")
    print("="*70 + "\n")

    code = input("Paste the Authorization Code here: ").strip()

    flow.fetch_token(code=code)
    credentials = flow.credentials

    print("\n" + "🎉"*20)
    print("✅ SUCCESS! Your Refresh Token is:")
    print("="*70)
    print(credentials.refresh_token)
    print("="*70)
    print("\nAdd this token to your GitHub Secrets as: GOOGLE_ADS_REFRESH_TOKEN\n")

if __name__ == "__main__":
    main()
