import os
import json
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from google_ads_service import get_client_from_dict, list_accounts, fetch_keyword_study

app = FastAPI(title="JevAds Live Google Ads API Explorer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CONFIG_PATH = os.path.expanduser("~/.config/jevads/google_ads_credentials.json")

class CredentialsPayload(BaseModel):
    developer_token: str
    client_id: str
    client_secret: str
    refresh_token: str
    login_customer_id: Optional[str] = None

class AccountStudyRequest(BaseModel):
    customer_id: str
    days: Optional[int] = 30
    credentials: Optional[CredentialsPayload] = None

@app.get("/api/credentials")
def get_saved_credentials():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r") as f:
                data = json.load(f)
                return {
                    "has_credentials": True,
                    "client_id": data.get("client_id", ""),
                    "login_customer_id": data.get("login_customer_id", ""),
                    "developer_token_set": bool(data.get("developer_token"))
                }
        except Exception:
            pass
    return {"has_credentials": False}

@app.post("/api/list-accounts")
def api_list_accounts(creds: CredentialsPayload):
    try:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        with open(CONFIG_PATH, "w") as f:
            json.dump(creds.dict(), f, indent=2)
            
        client = get_client_from_dict(creds.dict())
        accounts = list_accounts(client, creds.login_customer_id)
        return {
            "status": "success",
            "accounts_count": len(accounts),
            "accounts": accounts
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/study-account")
def api_study_account(req: AccountStudyRequest):
    try:
        creds_dict = {}
        if req.credentials:
            creds_dict = req.credentials.dict()
        elif os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r") as f:
                creds_dict = json.load(f)
        else:
            raise HTTPException(status_code=400, detail="No Google Ads credentials provided or saved.")

        client = get_client_from_dict(creds_dict)
        data = fetch_keyword_study(client, req.customer_id, req.days or 30)
        return {
            "status": "success",
            "data": data
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8090)
