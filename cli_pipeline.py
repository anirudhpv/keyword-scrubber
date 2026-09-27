import os
import json
import csv
from google_ads_service import load_client, fetch_keyword_study

def run():
    cid = os.getenv("TARGET_CUSTOMER_ID", "").strip()
    if not cid:
        print("❌ Error: TARGET_CUSTOMER_ID is required.")
        return

    days = int(os.getenv("DAYS_BACK", "30"))
    action_mode = os.getenv("ACTION_MODE", "study_and_scrub")
    os.makedirs("output", exist_ok=True)

    print(f"🚀 Starting JevAds for Customer ID: {cid} (Last {days} Days)...")
    data = fetch_keyword_study(cid, days=days)

    print(f"\n📊 --- ACCOUNT GROUND TRUTH STUDY ---")
    print(f"• Active Search Terms: {len(data['search_terms'])}")
    print(f"• Targeted Keywords: {len(data['targeted_keywords'])}")
    print(f"• Shared Negative Lists: {len(data['shared_lists'])}")
    print(f"• Local Ad Group Negatives: {len(data['local_negatives'])}")
    print(f"• Active Ads & Landing Pages: {len(data['landing_pages'])}")

    # Save Study JSON
    with open(f"output/study_{cid}.json", "w") as f:
        json.dump(data, f, indent=2)

    # If study_and_scrub, process search terms and generate Google Ads Editor CSV
    if action_mode == "study_and_scrub":
        csv_path = f"output/google_ads_editor_negatives_{cid}.csv"
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["Campaign", "Ad Group", "Criterion Type", "Keyword", "Reason", "Confidence"])
            
            for st in data["search_terms"]:
                q = st["search_term"].lower()
                # Classify
                if any(x in q for x in ["free", "crack", "torrent", "jobs", "salary", "pdf", "tutorial"]):
                    writer.writerow(["[Shared Negative List]", "", "Negative Exact", f"[{st['search_term']}]", "Universal_Waste", "0.98"])
                elif any(x in q for x in ["pricing", "cost", "vs", "comparison"]):
                    writer.writerow([st["campaign"], st["ad_group"], "Negative Phrase", f'"{st["search_term"]}"', "Traffic_Sculpting", "0.92"])
        
        print(f"✅ Generated Google Ads Editor CSV: {csv_path}")

    print("\n🎉 JevAds run completed successfully. Check artifacts for downloadable report.")

if __name__ == "__main__":
    run()
