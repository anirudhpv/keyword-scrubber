import os
import json
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from google_ads_service import load_client, list_accounts, fetch_account_blueprint

app = FastAPI(title="JevAds Live Google Ads API Explorer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "jev-ads-api"}

@app.get("/api/accounts")
def get_accounts():
    try:
        accounts = list_accounts()
        return {"status": "success", "accounts": accounts}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

class StudyRequest(BaseModel):
    customer_id: str
    days: Optional[int] = 30
    manager_id: Optional[str] = None

@app.post("/api/study-account")
def api_study_account(req: StudyRequest):
    try:
        data = fetch_account_blueprint(req.customer_id, req.days or 30)
        return {"status": "success", "data": data}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8090)
