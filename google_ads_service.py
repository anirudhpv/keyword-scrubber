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
    # 1. Try yaml file first
    for path in DEFAULT_YAML_PATHS:
        if os.path.exists(path):
            return GoogleAdsClient.load_from_storage(path, version="v25")
    
    # 2. Try environment variables
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

def list_accounts(login_cid: Optional[str] = None) -> List[Dict[str, Any]]:
    client = load_client()
    accounts = []
    ga_service = client.get_service("GoogleAdsService")
    
    cid = (login_cid or client.login_customer_id or "").replace("-", "").strip()
    if cid:
        query = """
            SELECT
                customer_client.client_customer,
                customer_client.id,
                customer_client.descriptive_name,
                customer_client.currency_code,
                customer_client.time_zone,
                customer_client.manager,
                customer_client.status
            FROM customer_client
            WHERE customer_client.status = 'ENABLED'
        """
        try:
            stream = ga_service.search_stream(customer_id=cid, query=query)
            for batch in stream:
                for row in batch.results:
                    cc = row.customer_client
                    accounts.append({
                        "id": str(cc.id),
                        "name": cc.descriptive_name or f"Account {cc.id}",
                        "currency": cc.currency_code,
                        "time_zone": cc.time_zone,
                        "is_manager": bool(cc.manager)
                    })
            if accounts:
                return accounts
        except Exception as e:
            print("Error querying customer_client:", e)

    customer_service = client.get_service("CustomerService")
    try:
        accessible = customer_service.list_accessible_customers()
        for resource_name in accessible.resource_names:
            c_id = resource_name.split("/")[-1]
            accounts.append({
                "id": c_id,
                "name": f"Customer {c_id}",
                "currency": "USD",
                "time_zone": "UTC",
                "is_manager": False
            })
    except Exception as e:
        print("Error listing accessible customers:", e)
    return accounts

def fetch_keyword_study(customer_id: str, days: int = 30) -> Dict[str, Any]:
    client = load_client()
    cid = customer_id.replace("-", "").strip()
    ga_service = client.get_service("GoogleAdsService")
    
    # 1. Search Terms
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

    # 2. Targeted Positive Keywords
    targeted_keywords = []
    kw_query = """
        SELECT
            campaign.name,
            ad_group.name,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type,
            ad_group_criterion.status
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = FALSE
          AND ad_group_criterion.status = 'ENABLED'
        LIMIT 500
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=kw_query)
        for batch in stream:
            for row in batch.results:
                targeted_keywords.append({
                    "keyword": row.ad_group_criterion.keyword.text,
                    "match_type": str(row.ad_group_criterion.keyword.match_type.name),
                    "campaign": row.campaign.name,
                    "ad_group": row.ad_group.name
                })
    except Exception as e:
        print("Error fetching targeted keywords:", e)

    # 3. Existing Negative Keywords
    local_negatives = []
    neg_query = """
        SELECT
            campaign.name,
            ad_group.name,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = TRUE
        LIMIT 300
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=neg_query)
        for batch in stream:
            for row in batch.results:
                local_negatives.append({
                    "keyword": row.ad_group_criterion.keyword.text,
                    "match_type": str(row.ad_group_criterion.keyword.match_type.name),
                    "level": "Ad Group",
                    "campaign": row.campaign.name,
                    "ad_group": row.ad_group.name
                })
    except Exception as e:
        print("Error fetching local negatives:", e)

    # 4. Shared Negative Lists
    shared_lists = []
    shared_query = """
        SELECT
            shared_set.id,
            shared_set.name,
            shared_set.type,
            shared_set.member_count
        FROM shared_set
        WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=shared_query)
        for batch in stream:
            for row in batch.results:
                shared_lists.append({
                    "id": str(row.shared_set.id),
                    "name": row.shared_set.name,
                    "member_count": row.shared_set.member_count
                })
    except Exception as e:
        print("Error fetching shared sets:", e)

    # 5. Landing Pages & RSAs
    landing_pages = []
    ad_query = """
        SELECT
            campaign.name,
            ad_group.name,
            ad_group_ad.ad.final_urls,
            ad_group_ad.ad.responsive_search_ad.headlines,
            ad_group_ad.ad.responsive_search_ad.descriptions
        FROM ad_group_ad
        WHERE ad_group_ad.status = 'ENABLED'
        LIMIT 50
    """
    try:
        stream = ga_service.search_stream(customer_id=cid, query=ad_query)
        for batch in stream:
            for row in batch.results:
                ad = row.ad_group_ad.ad
                urls = list(ad.final_urls) if ad.final_urls else []
                headlines = [h.text for h in ad.responsive_search_ad.headlines] if ad.responsive_search_ad else []
                descriptions = [d.text for d in ad.responsive_search_ad.descriptions] if ad.responsive_search_ad else []
                landing_pages.append({
                    "campaign": row.campaign.name,
                    "ad_group": row.ad_group.name,
                    "final_urls": urls,
                    "headlines": headlines[:4],
                    "descriptions": descriptions[:2]
                })
    except Exception as e:
        print("Error fetching ads/LPs:", e)

    return {
        "customer_id": customer_id,
        "search_terms": search_terms,
        "targeted_keywords": targeted_keywords,
        "local_negatives": local_negatives,
        "shared_lists": shared_lists,
        "landing_pages": landing_pages
    }
