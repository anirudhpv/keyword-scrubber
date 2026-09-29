import os
import json
from typing import Dict, Any, List, Optional
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException

DEFAULT_YAML_PATHS = [
    os.path.expanduser("~/.config/google-ads.yaml"),
    os.path.expanduser("~/google-ads.yaml"),
    "/home/apv/projects/jev-ads-scrubber/google-ads.yaml"
]

def load_client() -> GoogleAdsClient:
    for path in DEFAULT_YAML_PATHS:
        if os.path.exists(path):
            return GoogleAdsClient.load_from_storage(path, version="v25")
    
    dev_token = os.getenv("GOOGLE_ADS_DEVELOPER_TOKEN", "DEVELOPER_TOKEN_DEPRECATED").strip()
    client_id = os.getenv("GOOGLE_ADS_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_ADS_CLIENT_SECRET", "").strip()
    refresh_token = os.getenv("GOOGLE_ADS_REFRESH_TOKEN", "").strip()
    login_cid = os.getenv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", "").replace("-", "").strip()
    
    if client_id and refresh_token:
        config_dict = {
            "developer_token": dev_token or "DEVELOPER_TOKEN_DEPRECATED",
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "use_proto_plus": True
        }
        if login_cid:
            config_dict["login_customer_id"] = login_cid
        return GoogleAdsClient.load_from_dict(config_dict, version="v25")
        
    raise FileNotFoundError("Missing Google Ads OAuth credentials (GOOGLE_ADS_CLIENT_ID, REFRESH_TOKEN).")

def fetch_account_blueprint(customer_id: str, days: int = 30) -> Dict[str, Any]:
    client = load_client()
    cid = customer_id.replace("-", "").strip()
    ga_service = client.get_service("GoogleAdsService")
    
    # 1. Campaigns Structure
    campaigns = []
    camp_query = """
        SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=camp_query)
        for batch in stream:
            for row in batch.results:
                campaigns.append({
                    "id": str(row.campaign.id),
                    "name": row.campaign.name,
                    "status": str(row.campaign.status.name),
                    "type": str(row.campaign.advertising_channel_type.name),
                    "budget_daily": round((row.campaign_budget.amount_micros or 0) / 1_000_000, 2)
                })
    except Exception as e:
        print("Error fetching campaigns:", e)

    # 2. Ad Groups Structure
    ad_groups = []
    ag_query = """
        SELECT
            ad_group.id,
            ad_group.name,
            ad_group.status,
            campaign.id,
            campaign.name
        FROM ad_group
        WHERE ad_group.status != 'REMOVED'
        ORDER BY campaign.name, ad_group.name
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=ag_query)
        for batch in stream:
            for row in batch.results:
                ad_groups.append({
                    "id": str(row.ad_group.id),
                    "name": row.ad_group.name,
                    "status": str(row.ad_group.status.name),
                    "campaign_id": str(row.campaign.id),
                    "campaign_name": row.campaign.name
                })
    except Exception as e:
        print("Error fetching ad groups:", e)

    # 3. Shared Negative Lists (Shared Sets)
    shared_lists = []
    shared_query = """
        SELECT
            shared_set.id,
            shared_set.name,
            shared_set.type,
            shared_set.member_count
        FROM shared_set
        WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
          AND shared_set.status != 'REMOVED'
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=shared_query)
        for batch in stream:
            for row in batch.results:
                shared_lists.append({
                    "id": str(row.shared_set.id),
                    "name": row.shared_set.name,
                    "member_count": row.shared_set.member_count or 0,
                    "applied_campaigns": []
                })
    except Exception as e:
        print("Error fetching shared sets:", e)

    # 4. Campaign Shared Sets (Which campaign uses which Shared Negative List)
    list_map = {sl["id"]: sl for sl in shared_lists}
    css_query = """
        SELECT
            campaign.id,
            campaign.name,
            shared_set.id,
            shared_set.name,
            campaign_shared_set.status
        FROM campaign_shared_set
        WHERE campaign_shared_set.status = 'ENABLED'
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=css_query)
        for batch in stream:
            for row in batch.results:
                s_id = str(row.shared_set.id)
                if s_id in list_map:
                    list_map[s_id]["applied_campaigns"].append({
                        "campaign_id": str(row.campaign.id),
                        "campaign_name": row.campaign.name
                    })
    except Exception as e:
        print("Error fetching campaign shared sets:", e)

    # 5. Campaign-Level Negatives
    campaign_negatives = []
    camp_neg_query = """
        SELECT
            campaign.id,
            campaign.name,
            campaign_criterion.keyword.text,
            campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'KEYWORD'
          AND campaign_criterion.negative = TRUE
          AND campaign_criterion.status != 'REMOVED'
        LIMIT 500
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=camp_neg_query)
        for batch in stream:
            for row in batch.results:
                campaign_negatives.append({
                    "campaign_id": str(row.campaign.id),
                    "campaign_name": row.campaign.name,
                    "keyword": row.campaign_criterion.keyword.text,
                    "match_type": str(row.campaign_criterion.keyword.match_type.name)
                })
    except Exception as e:
        print("Error fetching campaign negatives:", e)

    # 6. Ad Group-Level Negatives (Sculpting)
    adgroup_negatives = []
    ag_neg_query = """
        SELECT
            campaign.name,
            ad_group.id,
            ad_group.name,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = TRUE
          AND ad_group_criterion.status != 'REMOVED'
        LIMIT 500
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=ag_neg_query)
        for batch in stream:
            for row in batch.results:
                adgroup_negatives.append({
                    "campaign_name": row.campaign.name,
                    "ad_group_id": str(row.ad_group.id),
                    "ad_group_name": row.ad_group.name,
                    "keyword": row.ad_group_criterion.keyword.text,
                    "match_type": str(row.ad_group_criterion.keyword.match_type.name)
                })
    except Exception as e:
        print("Error fetching ad group negatives:", e)

    # 7. Search Terms Report (Last N Days)
    search_terms = []
    st_query = f"""
        SELECT
            search_term_view.search_term,
            search_term_view.status,
            campaign.name,
            ad_group.name,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions
        FROM search_term_view
        WHERE segments.date DURING LAST_{days}_DAYS
        ORDER BY metrics.impressions DESC
        LIMIT 500
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=st_query)
        for batch in stream:
            for row in batch.results:
                search_terms.append({
                    "search_term": row.search_term_view.search_term,
                    "status": str(row.search_term_view.status.name),
                    "campaign": row.campaign.name,
                    "ad_group": row.ad_group.name,
                    "impressions": row.metrics.impressions,
                    "clicks": row.metrics.clicks,
                    "cost": round(row.metrics.cost_micros / 1_000_000, 2),
                    "conversions": round(row.metrics.conversions, 1)
                })
    except Exception as e:
        print("Error fetching search terms:", e)

    return {
        "customer_id": customer_id,
        "campaigns": campaigns,
        "ad_groups": ad_groups,
        "shared_lists": shared_lists,
        "campaign_negatives": campaign_negatives,
        "adgroup_negatives": adgroup_negatives,
        "search_terms": search_terms
    }
