"""JevAds backend - Google Ads negative-keyword viewer and search-term triage.

Auth is pure OAuth 2.0: the browser signs in, we exchange the code here, and
every Google Ads call rides on that user's bearer token. No developer token,
no google-ads.yaml, no service credentials on disk.
"""
import base64
import json
import os
import time
import urllib.parse
from typing import Any, Dict, List, Optional

import requests
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

import google_ads
from google_ads import API_VERSION, GoogleAdsError
from jev_triage import JevUnavailable, jev_health, triage

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="JevAds - Negative Keyword Architecture & Search Term Triage")

# Bearer tokens travel in the request body, not cookies, so credentialed
# requests are not needed - and "*" with credentials is rejected by browsers.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _read_env_file() -> Dict[str, str]:
    """Parse .env by hand so `export KEY="value"` lines work without dotenv."""
    values: Dict[str, str] = {}
    path = os.path.join(BASE_DIR, ".env")
    if not os.path.exists(path):
        return values
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].lstrip()
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def get_oauth_config() -> tuple:
    env = _read_env_file()
    client_id = (
        os.getenv("GOOGLE_ADS_CLIENT_ID")
        or env.get("GOOGLE_ADS_CLIENT_ID", "")
    ).strip()
    client_secret = (
        os.getenv("GOOGLE_ADS_CLIENT_SECRET")
        or env.get("GOOGLE_ADS_CLIENT_SECRET", "")
    ).strip()
    return client_id, client_secret


SCOPES = "openid email profile https://www.googleapis.com/auth/adwords"


@app.get("/")
def serve_index():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


@app.get("/api/health")
def health():
    client_id, client_secret = get_oauth_config()
    return {
        "status": "ok",
        "service": "jev-ads-api",
        "google_ads_api": API_VERSION,
        "oauth_configured": bool(client_id and client_secret),
        "jev": jev_health(),
    }


@app.get("/api/auth/login")
def auth_login(request: Request):
    client_id, _ = get_oauth_config()
    if not client_id:
        raise HTTPException(
            status_code=500,
            detail="GOOGLE_ADS_CLIENT_ID is not set in the environment or .env",
        )
    redirect_uri = f"{str(request.base_url).rstrip('/')}/api/auth/callback"
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
    })
    return RedirectResponse(
        f"https://accounts.google.com/o/oauth2/v2/auth?{params}", status_code=302
    )


def _decode_id_token(id_token: str) -> Dict[str, Any]:
    """Read the claims out of an id_token.

    Safe without signature verification only because this token came straight
    from Google's token endpoint over TLS. Never do this to a token from a client.
    """
    try:
        payload = id_token.split(".")[1]
        payload += "=" * ((4 - len(payload) % 4) % 4)
        return json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
    except Exception:
        return {}


def _session_payload(token_data: Dict[str, Any], existing_refresh: str = "") -> Dict[str, Any]:
    claims = _decode_id_token(token_data.get("id_token", ""))
    email = claims.get("email", "")
    name = claims.get("name", "")
    expires_in = int(token_data.get("expires_in") or 3600)
    return {
        "access_token": token_data.get("access_token", ""),
        # Google only returns a refresh token on first consent; keep the old one.
        "refresh_token": token_data.get("refresh_token") or existing_refresh,
        "email": email,
        "name": name,
        "display": f"{name} ({email})" if name and email else (email or "Google Ads user"),
        "picture": claims.get("picture", ""),
        # Epoch milliseconds, to match Date.now() in the browser. Renew a minute
        # early so a request never goes out on a token that expires mid-flight.
        "expires_at": int(time.time() * 1000) + (expires_in - 60) * 1000,
    }


@app.get("/api/auth/callback")
def auth_callback(request: Request, code: Optional[str] = None, error: Optional[str] = None):
    if error:
        return HTMLResponse(f"<h3>Google OAuth error: {error}</h3>", status_code=400)
    if not code:
        return HTMLResponse("<h3>Missing authorization code</h3>", status_code=400)

    client_id, client_secret = get_oauth_config()
    redirect_uri = f"{str(request.base_url).rstrip('/')}/api/auth/callback"

    try:
        resp = requests.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            timeout=15,
        )
        token_data = resp.json()
    except Exception as e:
        return HTMLResponse(f"<h3>Token exchange failed: {e}</h3>", status_code=500)

    if not resp.ok or "error" in token_data:
        return HTMLResponse(
            f"<h3>Token exchange failed</h3><pre>{json.dumps(token_data, indent=2)}</pre>",
            status_code=400,
        )

    session = _session_payload(token_data)
    # Escape "<" so a display name can never break out of the script element.
    blob = json.dumps(session).replace("<", "\\u003c")

    return HTMLResponse(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px;background:#fbf9f5">
  <h2>Signed in as {session['display']}</h2>
  <p>Returning to the dashboard&hellip;</p>
  <script>
    localStorage.setItem('jev_ads_auth_session', JSON.stringify({blob}));
    location.replace('/');
  </script>
</body></html>""")


class RefreshPayload(BaseModel):
    refresh_token: str


@app.post("/api/auth/refresh")
def auth_refresh(payload: RefreshPayload):
    """Mint a new access token so an expiring session does not force re-consent."""
    client_id, client_secret = get_oauth_config()
    if not payload.refresh_token:
        raise HTTPException(status_code=400, detail="Missing refresh_token")
    try:
        resp = requests.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": payload.refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=15,
        )
        token_data = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Token refresh failed: {e}")

    if not resp.ok or "error" in token_data:
        raise HTTPException(status_code=401, detail=token_data)
    return _session_payload(token_data, existing_refresh=payload.refresh_token)


# --- Google Ads --------------------------------------------------------------

class TokenPayload(BaseModel):
    access_token: str


class AccountPayload(BaseModel):
    access_token: str
    customer_id: str
    login_customer_id: Optional[str] = ""


class TriagePayload(AccountPayload):
    days: Optional[int] = 30
    min_clicks: Optional[int] = 2
    min_cost: Optional[float] = 0.0


def _ads_error(e: GoogleAdsError) -> HTTPException:
    return HTTPException(
        status_code=e.status if e.status in (400, 401, 403, 404, 429) else 400,
        detail={"error": str(e), "details": e.details, "api_version": API_VERSION},
    )


@app.post("/api/accounts")
def api_accounts(payload: TokenPayload):
    if not payload.access_token.strip():
        raise HTTPException(status_code=401, detail="Missing access_token")
    try:
        accounts, errors = google_ads.discover_accounts(payload.access_token.strip())
    except GoogleAdsError as e:
        raise _ads_error(e)
    return {"accounts": accounts, "warnings": errors}


@app.post("/api/negatives")
def api_negatives(payload: AccountPayload):
    """Every negative keyword on the account, grouped by level."""
    try:
        structure = google_ads.fetch_structure(
            payload.access_token, payload.customer_id, payload.login_customer_id or ""
        )
        negatives = google_ads.fetch_negatives(
            payload.access_token, payload.customer_id, payload.login_customer_id or ""
        )
    except GoogleAdsError as e:
        raise _ads_error(e)

    return {
        "customer_id": payload.customer_id,
        "api_version": API_VERSION,
        **structure,
        **negatives,
    }


@app.post("/api/triage")
def api_triage(payload: TriagePayload):
    """Full view: structure, negatives, and JEV-routed search-term recommendations."""
    try:
        structure = google_ads.fetch_structure(
            payload.access_token, payload.customer_id, payload.login_customer_id or ""
        )
        negatives = google_ads.fetch_negatives(
            payload.access_token, payload.customer_id, payload.login_customer_id or ""
        )
        terms = google_ads.fetch_search_terms(
            payload.access_token, payload.customer_id,
            payload.days or 30, payload.login_customer_id or "",
        )
    except GoogleAdsError as e:
        raise _ads_error(e)

    try:
        result = triage(
            terms, negatives,
            min_clicks=payload.min_clicks if payload.min_clicks is not None else 2,
            min_cost=payload.min_cost or 0.0,
        )
    except JevUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))

    return {
        "customer_id": payload.customer_id,
        "api_version": API_VERSION,
        "days": payload.days or 30,
        **structure,
        **negatives,
        "search_terms_fetched": len(terms),
        **result,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8090)
