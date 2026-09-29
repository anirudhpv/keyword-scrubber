import os
import json
import csv
from google_ads_service import fetch_account_blueprint

def run():
    cid = os.getenv("TARGET_CUSTOMER_ID", "").strip()
    if not cid:
        print("❌ Error: TARGET_CUSTOMER_ID is required.")
        return

    days = int(os.getenv("DAYS_BACK", "30"))
    os.makedirs("output", exist_ok=True)

    print(f"🚀 Pulling Account Blueprint & Negative Architecture for CID: {cid}...")
    blueprint = fetch_account_blueprint(cid, days=days)

    print(f"\n📊 --- ACCOUNT ARCHITECTURE & COVERAGE ---")
    print(f"• Active Campaigns: {len(blueprint['campaigns'])}")
    print(f"• Active Ad Groups: {len(blueprint['ad_groups'])}")
    print(f"• Shared Negative Lists: {len(blueprint['shared_lists'])}")
    for sl in blueprint['shared_lists']:
        applied = [c['campaign_name'] for c in sl['applied_campaigns']]
        print(f"   ↳ 📋 List: \"{sl['name']}\" ({sl['member_count']} items) -> Applied to {len(applied)} campaigns: {applied[:3]}")

    print(f"• Campaign-Level Negatives: {len(blueprint['campaign_negatives'])}")
    print(f"• Ad Group-Level Negatives (Sculpting): {len(blueprint['adgroup_negatives'])}")
    print(f"• Live Search Terms: {len(blueprint['search_terms'])}")

    with open(f"output/blueprint_{cid}.json", "w") as f:
        json.dump(blueprint, f, indent=2)

    print("\n✅ Blueprint generated successfully.")

if __name__ == "__main__":
    run()
