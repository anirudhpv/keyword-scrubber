import os
import json
import base64
import urllib.parse
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
import uvicorn
from google_ads_service import load_client, list_accounts, fetch_account_blueprint

# Try loading .env if present
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = FastAPI(title="JevAds Live Google Ads API Explorer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CONFIG_PATH = os.path.expanduser("~/.config/jevads/google_ads_credentials.json")

def get_oauth_credentials():
    client_id = os.getenv("GOOGLE_ADS_CLIENT_ID") or os.getenv("GOOGLE_CLIENT_ID") or ""
    client_secret = os.getenv("GOOGLE_ADS_CLIENT_SECRET") or os.getenv("GOOGLE_CLIENT_SECRET") or ""
    dev_token = os.getenv("GOOGLE_ADS_DEVELOPER_TOKEN") or ""
    
    env_file = "/home/apv/projects/jev-ads-scrubber/.env"
    if os.path.exists(env_file):
        try:
            import re
            with open(env_file, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    m = re.match(r"^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$", line)
                    if m:
                        k, v = m.group(1), m.group(2).strip('"')
                        if k in ("GOOGLE_ADS_CLIENT_ID", "GOOGLE_CLIENT_ID") and not client_id:
                            client_id = v
                        elif k in ("GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET") and not client_secret:
                            client_secret = v
                        elif k in ("GOOGLE_ADS_DEVELOPER_TOKEN", "DEVELOPER_TOKEN") and not dev_token:
                            dev_token = v
        except Exception:
            pass

    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r") as f:
                saved = json.load(f)
                client_id = client_id or saved.get("client_id", "").strip()
                client_secret = client_secret or saved.get("client_secret", "").strip()
                dev_token = dev_token or saved.get("developer_token", "").strip()
        except Exception:
            pass
            
    return client_id.strip(), client_secret.strip(), dev_token.strip()

@app.get("/")
def serve_index():
    return FileResponse("/home/apv/projects/jev-ads-scrubber/index.html")

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "jev-ads-api"}

@app.get("/api/auth/login")
def auth_login(request: Request):
    client_id, _, _ = get_oauth_credentials()
    if not client_id:
        raise HTTPException(
            status_code=500, 
            detail="Missing GOOGLE_ADS_CLIENT_ID in environment, .env, or ~/.config/jevads/google_ads_credentials.json."
        )
    
    base_url = str(request.base_url).rstrip("/")
    redirect_uri = f"{base_url}/api/auth/callback"
    scope = urllib.parse.quote("openid email profile https://www.googleapis.com/auth/adwords")
    
    auth_url = (
        f"https://accounts.google.com/o/oauth2/v2/auth?"
        f"client_id={urllib.parse.quote(client_id)}&"
        f"redirect_uri={urllib.parse.quote(redirect_uri)}&"
        f"response_type=code&"
        f"scope={scope}&"
        f"access_type=offline&"
        f"prompt=consent"
    )
    return RedirectResponse(auth_url, status_code=302)

@app.get("/api/auth/callback")
def auth_callback(request: Request, code: Optional[str] = None, error: Optional[str] = None):
    if error:
        return HTMLResponse(f"<h3>Google OAuth Error: {error}</h3>", status_code=400)
    if not code:
        return HTMLResponse("<h3>Missing authorization code from Google</h3>", status_code=400)

    client_id, client_secret, _ = get_oauth_credentials()
    base_url = str(request.base_url).rstrip("/")
    redirect_uri = f"{base_url}/api/auth/callback"

    try:
        token_resp = requests.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code"
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15
        )
        token_data = token_resp.json()
        if not token_resp.ok or "error" in token_data:
            return HTMLResponse(f"<h3>Token Exchange Failed:</h3><pre>{json.dumps(token_data, indent=2)}</pre>", status_code=400)

        user_email = ""
        user_name = ""
        user_pic = ""

        if "id_token" in token_data:
            try:
                payload_b64 = token_data["id_token"].split(".")[1]
                payload_b64 += "=" * ((4 - len(payload_b64) % 4) % 4)
                decoded = json.loads(base64.urlsafe_b64decode(payload_b64.encode("utf-8")).decode("utf-8"))
                user_email = decoded.get("email", "")
                user_name = decoded.get("name", "")
                user_pic = decoded.get("picture", "")
            except Exception:
                pass

        if not user_email and "access_token" in token_data:
            try:
                u_resp = requests.get(
                    "https://www.googleapis.com/oauth2/v3/userinfo",
                    headers={"Authorization": f"Bearer {token_data['access_token']}"},
                    timeout=10
                )
                if u_resp.ok:
                    u_data = u_resp.json()
                    user_email = u_data.get("email", "")
                    user_name = u_data.get("name", "") or user_name
                    user_pic = u_data.get("picture", "") or user_pic
            except Exception:
                pass

        final_display = f"{user_name} ({user_email})" if user_name and user_email else (user_email or "Google Ads User")
        
        session_payload = {
            "access_token": token_data.get("access_token"),
            "refresh_token": token_data.get("refresh_token", ""),
            "email": user_email or final_display,
            "name": user_name,
            "display": final_display,
            "picture": user_pic,
            "expires_at": int(os.times().elapsed * 1000) + int((token_data.get("expires_in", 3600) * 1000))
        }

        html = f"""
        <!DOCTYPE html>
        <html>
        <head><title>Authenticated</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #fbf9f5;">
          <h2>Authenticated as {final_display}</h2>
          <p>Saving session and redirecting to dashboard...</p>
          <script>
            localStorage.setItem('jev_ads_auth_session', JSON.stringify({json.dumps(session_payload)}));
            window.location.href = '/';
          </script>
        </body>
        </html>
        """
        return HTMLResponse(content=html)

    except Exception as e:
        return HTMLResponse(f"<h3>OAuth Error: {str(e)}</h3>", status_code=500)

class AccountsDiscoveryPayload(BaseModel):
    access_token: str

@app.post("/api/google-ads/accounts")
def api_google_ads_accounts(payload: AccountsDiscoveryPayload):
    access_token = payload.access_token.strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="Missing access_token")

    _, _, dev_token = get_oauth_credentials()
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    if dev_token and dev_token != "DEVELOPER_TOKEN_DEPRECATED":
        headers["developer-token"] = dev_token

    try:
        list_resp = requests.get(
            "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",
            headers=headers,
            timeout=15
        )
        list_data = list_resp.json()
        if not list_resp.ok:
            return JSONResponse(status_code=list_resp.status_code, content={"error": "Failed to list accessible customers", "details": list_data})

        top_cids = [rn.split("/")[1] for rn in list_data.get("resourceNames", [])]
        discovered_accounts = []
        seen = set()

        for top_cid in top_cids:
            try:
                gaql = """
                    SELECT
                        customer_client.client_customer,
                        customer_client.id,
                        customer_client.descriptive_name,
                        customer_client.currency_code,
                        customer_client.time_zone,
                        customer_client.manager,
                        customer_client.status,
                        customer_client.level
                    FROM customer_client
                    WHERE customer_client.status = 'ENABLED'
                """
                stream_headers = dict(headers)
                stream_headers["login-customer-id"] = top_cid
                
                s_resp = requests.post(
                    f"https://googleads.googleapis.com/v25/customers/{top_cid}/googleAds:searchStream",
                    headers=stream_headers,
                    json={"query": gaql},
                    timeout=15
                )
                if s_resp.ok:
                    stream_batches = s_resp.json()
                    for batch in stream_batches:
                        for row in batch.get("results", []):
                            cc = row.get("customerClient", {})
                            c_id = str(cc.get("id", ""))
                            if c_id and c_id not in seen:
                                seen.add(c_id)
                                formatted_cid = f"{c_id[:3]}-{c_id[3:6]}-{c_id[6:]}" if len(c_id) == 10 else c_id
                                is_mgr = bool(cc.get("manager"))
                                name = cc.get("descriptiveName") or f"Account {formatted_cid}"
                                
                                discovered_accounts.append({
                                    "id": c_id,
                                    "formatted_id": formatted_cid,
                                    "name": f"{name} ({formatted_cid})",
                                    "raw_name": name,
                                    "is_manager": is_mgr,
                                    "manager_id": c_id if is_mgr else top_cid,
                                    "currency": cc.get("currencyCode", "USD"),
                                    "level": cc.get("level", 0)
                                })
            except Exception as e:
                print(f"Error expanding hierarchy for {top_cid}:", e)

            if top_cid not in seen:
                seen.add(top_cid)
                formatted_cid = f"{top_cid[:3]}-{top_cid[3:6]}-{top_cid[6:]}" if len(top_cid) == 10 else top_cid
                discovered_accounts.append({
                    "id": top_cid,
                    "formatted_id": formatted_cid,
                    "name": f"Account ({formatted_cid})",
                    "raw_name": f"Account {formatted_cid}",
                    "is_manager": False,
                    "manager_id": top_cid,
                    "currency": "USD",
                    "level": 0
                })

        discovered_accounts.sort(key=lambda x: (1 if x["is_manager"] else 0, x["name"]))
        return {"accounts": discovered_accounts}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class StudyPayload(BaseModel):
    customer_id: str
    days: Optional[int] = 30
    manager_id: Optional[str] = None
    access_token: Optional[str] = None

@app.post("/api/google-ads/study")
def api_google_ads_study(payload: StudyPayload):
    access_token = (payload.access_token or "").strip()
    cid = payload.customer_id.replace("-", "").strip()
    mgr_id = (payload.manager_id or "").replace("-", "").strip()
    days = payload.days or 30

    if not cid:
        raise HTTPException(status_code=400, detail="Missing customer_id")

    if access_token:
        _, _, dev_token = get_oauth_credentials()
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json"
        }
        if dev_token and dev_token != "DEVELOPER_TOKEN_DEPRECATED":
            headers["developer-token"] = dev_token
        if mgr_id and mgr_id != cid:
            headers["login-customer-id"] = mgr_id

        last_err = None

        def run_gaql(query: str):
            nonlocal last_err
            try:
                r = requests.post(
                    f"https://googleads.googleapis.com/v25/customers/{cid}/googleAds:searchStream",
                    headers=headers,
                    json={"query": query},
                    timeout=20
                )
                data = r.json()
                if not r.ok:
                    last_err = data
                    return []
                rows = []
                if isinstance(data, list):
                    for b in data:
                        rows.extend(b.get("results", []))
                return rows
            except Exception as e:
                last_err = {"error": str(e)}
                return []

        camp_rows = run_gaql("SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name")
        if not camp_rows and last_err:
            raise HTTPException(status_code=400, detail={"error": "Google Ads API Query Error", "details": last_err})

        campaigns = [{
            "id": str(r.get("campaign", {}).get("id", "")),
            "name": r.get("campaign", {}).get("name", "Unnamed Campaign"),
            "status": r.get("campaign", {}).get("status", "ENABLED"),
            "type": r.get("campaign", {}).get("advertisingChannelType", "SEARCH"),
            "budget_daily": round((r.get("campaignBudget", {}).get("amountMicros", 0) or 0) / 1000000, 2)
        } for r in camp_rows]

        ag_rows = run_gaql("SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name FROM ad_group WHERE ad_group.status != 'REMOVED' ORDER BY campaign.name, ad_group.name")
        ad_groups = [{
            "id": str(r.get("adGroup", {}).get("id", "")),
            "name": r.get("adGroup", {}).get("name", "Unnamed AdGroup"),
            "status": r.get("adGroup", {}).get("status", "ENABLED"),
            "campaign_id": str(r.get("campaign", {}).get("id", "")),
            "campaign_name": r.get("campaign", {}).get("name", "")
        } for r in ag_rows]

        shared_rows = run_gaql("SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.member_count FROM shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status != 'REMOVED'")
        shared_lists = [{
            "id": str(r.get("sharedSet", {}).get("id", "")),
            "name": r.get("sharedSet", {}).get("name", "Shared Negative List"),
            "member_count": r.get("sharedSet", {}).get("memberCount", 0),
            "applied_campaigns": []
        } for r in shared_rows]

        list_map = {sl["id"]: sl for sl in shared_lists}
        css_rows = run_gaql("SELECT campaign.id, campaign.name, shared_set.id, shared_set.name FROM campaign_shared_set WHERE campaign_shared_set.status = 'ENABLED'")
        for r in css_rows:
            sid = str(r.get("sharedSet", {}).get("id", ""))
            if sid in list_map:
                list_map[sid]["applied_campaigns"].append({
                    "campaign_id": str(r.get("campaign", {}).get("id", "")),
                    "campaign_name": r.get("campaign", {}).get("name", "")
                })

        camp_neg_rows = run_gaql("SELECT campaign.id, campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED' LIMIT 300")
        campaign_negatives = [{
            "campaign_id": str(r.get("campaign", {}).get("id", "")),
            "campaign_name": r.get("campaign", {}).get("name", ""),
            "keyword": r.get("campaignCriterion", {}).get("keyword", {}).get("text", ""),
            "match_type": r.get("campaignCriterion", {}).get("keyword", {}).get("matchType", "BROAD")
        } for r in camp_neg_rows]

        ag_neg_rows = run_gaql("SELECT campaign.name, ad_group.id, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = TRUE AND ad_group_criterion.status != 'REMOVED' LIMIT 300")
        adgroup_negatives = [{
            "campaign_name": r.get("campaign", {}).get("name", ""),
            "ad_group_id": str(r.get("adGroup", {}).get("id", "")),
            "ad_group_name": r.get("adGroup", {}).get("name", ""),
            "keyword": r.get("adGroupCriterion", {}).get("keyword", {}).get("text", ""),
            "match_type": r.get("adGroupCriterion", {}).get("keyword", {}).get("matchType", "EXACT")
        } for r in ag_neg_rows]

        st_rows = run_gaql(f"SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING LAST_{days}_DAYS ORDER BY metrics.impressions DESC LIMIT 500")
        search_terms = [{
            "search_term": r.get("searchTermView", {}).get("searchTerm", ""),
            "status": r.get("searchTermView", {}).get("status", "NONE"),
            "campaign": r.get("campaign", {}).get("name", ""),
            "ad_group": r.get("adGroup", {}).get("name", ""),
            "impressions": r.get("metrics", {}).get("impressions", 0),
            "clicks": r.get("metrics", {}).get("clicks", 0),
            "cost": round((r.get("metrics", {}).get("costMicros", 0) or 0) / 1000000, 2),
            "conversions": round(r.get("metrics", {}).get("conversions", 0) or 0, 2)
        } for r in st_rows]

        return {
            "data": {
                "customer_id": cid,
                "campaigns": campaigns,
                "ad_groups": ad_groups,
                "shared_lists": shared_lists,
                "campaign_negatives": campaign_negatives,
                "adgroup_negatives": adgroup_negatives,
                "search_terms": search_terms
            }
        }

    try:
        data = fetch_account_blueprint(cid, days)
        return {"status": "success", "data": data}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8090)
