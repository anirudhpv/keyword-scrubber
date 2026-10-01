"""Headless triage run — same analysis as the web UI, no browser.

Needs GOOGLE_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN in the environment.
Generate a refresh token once with generate_refresh_token.py.
"""
import json
import os
import sys

import requests

import google_ads
from jev_triage import triage


def access_token_from_refresh() -> str:
    resp = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }, timeout=20)
    resp.raise_for_status()
    return resp.json()["access_token"]


def run() -> int:
    cid = os.getenv("TARGET_CUSTOMER_ID", "").strip()
    if not cid:
        print("TARGET_CUSTOMER_ID is required", file=sys.stderr)
        return 1

    login_cid = os.getenv("LOGIN_CUSTOMER_ID", "").strip()
    days = int(os.getenv("DAYS_BACK", "30"))
    token = access_token_from_refresh()

    print(f"Pulling {google_ads.API_VERSION} blueprint for {google_ads.format_cid(cid)}...")
    structure = google_ads.fetch_structure(token, cid, login_cid)
    negatives = google_ads.fetch_negatives(token, cid, login_cid)
    terms = google_ads.fetch_search_terms(token, cid, days, login_cid)

    print(f"  {len(structure['campaigns'])} campaigns, {len(structure['ad_groups'])} ad groups")
    print(f"  {negatives['total_negatives']} negatives "
          f"({len(negatives['shared_lists'])} shared lists, "
          f"{len(negatives['campaign_negatives'])} campaign, "
          f"{len(negatives['adgroup_negatives'])} ad group)")
    print(f"  {len(terms)} search terms over {days} days\n")

    result = triage(terms, negatives, min_clicks=int(os.getenv("MIN_CLICKS", "2")))
    s = result["summary"]
    print(f"Triage ({s['jev_questions']} JEV decisions in {s['jev_latency_ms']}ms):")
    for action, count in sorted(s["by_action"].items(), key=lambda kv: -kv[1]):
        print(f"  {action:22} {count}")
    print(f"\n  Recoverable spend: ${s['wasted_spend']:.2f}")
    print(f"  Leaking past existing negatives: ${s['leaking_spend']:.2f}")

    os.makedirs("output", exist_ok=True)
    path = f"output/triage_{cid}.json"
    with open(path, "w") as f:
        json.dump({**structure, **negatives, **result}, f, indent=2)
    print(f"\nWrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
