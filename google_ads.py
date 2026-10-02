"""Thin Google Ads REST client (v26).

OAuth bearer tokens only - no developer token, no google-ads.yaml, no
client library. Every call goes through googleAds:searchStream.
"""
import os
from typing import Any, Dict, Iterable, List, Optional

import requests

# Latest GA major version (released 2026-07-22). Only MAJOR versions appear in
# REST paths - minor releases (v25.1, v25.2) apply automatically to this same
# endpoint, so calling /v25 today serves the v25.2 feature set. A /v26 path is
# already routed at the gateway but is undocumented and not yet released; do
# not move to it until it appears in the official release notes.
API_VERSION = "v25"
BASE = f"https://googleads.googleapis.com/{API_VERSION}"

# Google Ads rejects a searchStream page larger than this.
PAGE_LIMIT = 10000


class GoogleAdsError(RuntimeError):
    """A non-2xx response from the Google Ads API, with the parsed body."""

    def __init__(self, message: str, details: Any = None, status: int = 400):
        super().__init__(message)
        self.details = details
        self.status = status


def _headers(access_token: str, login_customer_id: str = "") -> Dict[str, str]:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    login_cid = (login_customer_id or "").replace("-", "").strip()
    if login_cid:
        headers["login-customer-id"] = login_cid
    return headers


def g(row: Any, *path: str, default: Any = "") -> Any:
    """Walk a nested GAQL result safely.

    Google serialises protobuf to JSON with default-valued fields omitted, so a
    nested object can be missing entirely on a row that is otherwise fine.
    Indexing straight into it raises KeyError and takes down the whole request.
    """
    cur = row
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
        if cur is None:
            return default
    return cur


def _extract_error(body: Any) -> str:
    """Pull the most useful human-readable message out of an error body."""
    if isinstance(body, list) and body:
        body = body[0]
    if not isinstance(body, dict):
        return str(body)[:300]
    err = body.get("error", body)
    if not isinstance(err, dict):
        return str(err)[:300]

    # GoogleAdsFailure carries the precise per-field reason.
    for detail in err.get("details", []) or []:
        for failure in detail.get("errors", []) or []:
            msg = failure.get("message")
            if msg:
                return msg
    return err.get("message", "Unknown Google Ads API error")


def search(
    access_token: str,
    customer_id: str,
    query: str,
    login_customer_id: str = "",
    timeout: int = 30,
) -> List[Dict[str, Any]]:
    """Run one GAQL query and return the flattened result rows."""
    cid = customer_id.replace("-", "").strip()
    resp = requests.post(
        f"{BASE}/customers/{cid}/googleAds:searchStream",
        headers=_headers(access_token, login_customer_id),
        json={"query": query},
        timeout=timeout,
    )

    try:
        body = resp.json()
    except ValueError:
        raise GoogleAdsError(
            f"Non-JSON response from Google Ads ({resp.status_code})",
            details=resp.text[:500],
            status=resp.status_code,
        )

    if not resp.ok:
        raise GoogleAdsError(_extract_error(body), details=body, status=resp.status_code)

    rows: List[Dict[str, Any]] = []
    # searchStream returns an array of batches; a single-batch reply may be bare.
    batches = body if isinstance(body, list) else [body]
    for batch in batches:
        rows.extend(batch.get("results", []) or [])
    return rows


def list_accessible_customers(access_token: str, timeout: int = 20) -> List[str]:
    """Return the customer IDs this OAuth token can reach directly."""
    resp = requests.get(
        f"{BASE}/customers:listAccessibleCustomers",
        headers=_headers(access_token),
        timeout=timeout,
    )
    try:
        body = resp.json()
    except ValueError:
        raise GoogleAdsError(
            f"Non-JSON response from Google Ads ({resp.status_code})",
            details=resp.text[:500],
            status=resp.status_code,
        )
    if not resp.ok:
        raise GoogleAdsError(_extract_error(body), details=body, status=resp.status_code)
    return [rn.split("/")[-1] for rn in body.get("resourceNames", []) or []]


def format_cid(cid: str) -> str:
    cid = str(cid)
    return f"{cid[:3]}-{cid[3:6]}-{cid[6:]}" if len(cid) == 10 else cid


HIERARCHY_QUERY = """
    SELECT
        customer_client.id,
        customer_client.descriptive_name,
        customer_client.currency_code,
        customer_client.time_zone,
        customer_client.manager,
        customer_client.level
    FROM customer_client
    WHERE customer_client.status = 'ENABLED'
"""


def discover_accounts(access_token: str) -> List[Dict[str, Any]]:
    """Expand every reachable login customer into its full client hierarchy."""
    top_cids = list_accessible_customers(access_token)
    accounts: List[Dict[str, Any]] = []
    seen = set()
    errors: List[str] = []

    for top_cid in top_cids:
        expanded = False
        try:
            for row in search(access_token, top_cid, HIERARCHY_QUERY, login_customer_id=top_cid):
                cc = row.get("customerClient", {})
                c_id = str(cc.get("id", ""))
                if not c_id or c_id in seen:
                    continue
                seen.add(c_id)
                expanded = True
                is_manager = bool(cc.get("manager"))
                name = cc.get("descriptiveName") or f"Account {format_cid(c_id)}"
                accounts.append({
                    "id": c_id,
                    "formatted_id": format_cid(c_id),
                    "name": name,
                    "label": f"{name} ({format_cid(c_id)})",
                    "is_manager": is_manager,
                    # A client account must authenticate through its manager.
                    "login_customer_id": "" if c_id == top_cid else top_cid,
                    "currency": cc.get("currencyCode", ""),
                    "level": cc.get("level", 0),
                })
        except GoogleAdsError as e:
            errors.append(f"{format_cid(top_cid)}: {e}")

        # Fall back to the bare login customer if the hierarchy query gave nothing.
        if not expanded and top_cid not in seen:
            seen.add(top_cid)
            accounts.append({
                "id": top_cid,
                "formatted_id": format_cid(top_cid),
                "name": f"Account {format_cid(top_cid)}",
                "label": f"Account ({format_cid(top_cid)})",
                "is_manager": False,
                "login_customer_id": "",
                "currency": "",
                "level": 0,
            })

    accounts.sort(key=lambda a: (a["is_manager"], a["name"].lower()))
    return accounts, errors


# --- Account structure -------------------------------------------------------

def fetch_structure(access_token: str, cid: str, login_cid: str = "") -> Dict[str, Any]:
    """Campaigns and ad groups, keyed for fast lookup during triage."""
    camp_rows = search(access_token, cid, """
        SELECT campaign.id, campaign.name, campaign.status,
               campaign.advertising_channel_type, campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name
    """, login_cid)

    campaigns = [{
        "id": str(g(r, "campaign", "id")),
        "name": g(r, "campaign", "name", default="Unnamed campaign"),
        "status": g(r, "campaign", "status", default="UNKNOWN"),
        "type": g(r, "campaign", "advertisingChannelType", default="UNKNOWN"),
        "budget_daily": round((g(r, "campaignBudget", "amountMicros", default=0) or 0) / 1_000_000, 2),
    } for r in camp_rows if g(r, "campaign", "id")]

    ag_rows = search(access_token, cid, """
        SELECT ad_group.id, ad_group.name, ad_group.status,
               campaign.id, campaign.name
        FROM ad_group
        WHERE ad_group.status != 'REMOVED'
        ORDER BY campaign.name, ad_group.name
    """, login_cid)

    ad_groups = [{
        "id": str(g(r, "adGroup", "id")),
        "name": g(r, "adGroup", "name", default="Unnamed ad group"),
        "status": g(r, "adGroup", "status", default="UNKNOWN"),
        "campaign_id": str(g(r, "campaign", "id")),
        "campaign_name": g(r, "campaign", "name"),
    } for r in ag_rows if g(r, "adGroup", "id")]

    return {"campaigns": campaigns, "ad_groups": ad_groups}


def fetch_negatives(access_token: str, cid: str, login_cid: str = "") -> Dict[str, Any]:
    """Every negative keyword on the account, at all three levels.

    Shared-list members come from shared_criterion - shared_set alone only
    reports a member count, not the keywords themselves.
    """
    # 1. Shared negative sets (the containers).
    set_rows = search(access_token, cid, """
        SELECT shared_set.id, shared_set.name, shared_set.member_count
        FROM shared_set
        WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
          AND shared_set.status != 'REMOVED'
    """, login_cid)

    shared_lists: Dict[str, Dict[str, Any]] = {}
    for r in set_rows:
        sid = str(g(r, "sharedSet", "id"))
        if not sid:
            continue
        shared_lists[sid] = {
            "id": sid,
            "name": g(r, "sharedSet", "name", default="Shared negative list"),
            "member_count": int(g(r, "sharedSet", "memberCount", default=0) or 0),
            "keywords": [],
            "applied_campaigns": [],
        }

    # 2. The actual keywords inside each shared set.
    crit_rows = search(access_token, cid, """
        SELECT shared_set.id, shared_criterion.keyword.text,
               shared_criterion.keyword.match_type
        FROM shared_criterion
        WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
          AND shared_set.status != 'REMOVED'
    """, login_cid)

    for r in crit_rows:
        sid = str(r.get("sharedSet", {}).get("id", ""))
        kw = r.get("sharedCriterion", {}).get("keyword", {})
        if sid in shared_lists and kw.get("text"):
            shared_lists[sid]["keywords"].append({
                "text": kw["text"],
                "match_type": kw.get("matchType", "BROAD"),
            })

    # 3. Which campaigns each set is attached to.
    link_rows = search(access_token, cid, """
        SELECT campaign.id, campaign.name, shared_set.id
        FROM campaign_shared_set
        WHERE campaign_shared_set.status = 'ENABLED'
    """, login_cid)

    for r in link_rows:
        sid = str(r.get("sharedSet", {}).get("id", ""))
        if sid in shared_lists:
            shared_lists[sid]["applied_campaigns"].append({
                "campaign_id": str(g(r, "campaign", "id")),
                "campaign_name": g(r, "campaign", "name"),
            })

    # 4. Campaign-level negatives.
    camp_neg_rows = search(access_token, cid, f"""
        SELECT campaign.id, campaign.name,
               campaign_criterion.keyword.text,
               campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'KEYWORD'
          AND campaign_criterion.negative = TRUE
          AND campaign_criterion.status != 'REMOVED'
        LIMIT {PAGE_LIMIT}
    """, login_cid)

    campaign_negatives = [{
        "campaign_id": str(g(r, "campaign", "id")),
        "campaign_name": g(r, "campaign", "name"),
        "text": r.get("campaignCriterion", {}).get("keyword", {}).get("text", ""),
        "match_type": r.get("campaignCriterion", {}).get("keyword", {}).get("matchType", "BROAD"),
    } for r in camp_neg_rows if g(r, "campaignCriterion", "keyword", "text")]

    # 5. Ad group-level negatives (traffic sculpting).
    ag_neg_rows = search(access_token, cid, f"""
        SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
               ad_group_criterion.keyword.text,
               ad_group_criterion.keyword.match_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = TRUE
          AND ad_group_criterion.status != 'REMOVED'
        LIMIT {PAGE_LIMIT}
    """, login_cid)

    adgroup_negatives = [{
        "campaign_id": str(g(r, "campaign", "id")),
        "campaign_name": g(r, "campaign", "name"),
        "ad_group_id": str(g(r, "adGroup", "id")),
        "ad_group_name": g(r, "adGroup", "name"),
        "text": r.get("adGroupCriterion", {}).get("keyword", {}).get("text", ""),
        "match_type": r.get("adGroupCriterion", {}).get("keyword", {}).get("matchType", "BROAD"),
    } for r in ag_neg_rows if g(r, "adGroupCriterion", "keyword", "text")]

    lists = sorted(shared_lists.values(), key=lambda s: s["name"].lower())
    total = (
        sum(len(s["keywords"]) for s in lists)
        + len(campaign_negatives)
        + len(adgroup_negatives)
    )

    return {
        "shared_lists": lists,
        "campaign_negatives": campaign_negatives,
        "adgroup_negatives": adgroup_negatives,
        "total_negatives": total,
    }


def fetch_search_terms(
    access_token: str, cid: str, days: int = 30, login_cid: str = "", limit: int = 2000
) -> List[Dict[str, Any]]:
    """Search terms with the campaign/ad group IDs triage needs for placement."""
    rows = search(access_token, cid, f"""
        SELECT search_term_view.search_term,
               search_term_view.status,
               campaign.id, campaign.name,
               ad_group.id, ad_group.name,
               metrics.impressions, metrics.clicks,
               metrics.cost_micros, metrics.conversions,
               metrics.conversions_value
        FROM search_term_view
        WHERE segments.date DURING LAST_{days}_DAYS
        ORDER BY metrics.cost_micros DESC
        LIMIT {min(limit, PAGE_LIMIT)}
    """, login_cid)

    terms = []
    for r in rows:
        m = r.get("metrics", {})
        terms.append({
            "term": r.get("searchTermView", {}).get("searchTerm", ""),
            "status": r.get("searchTermView", {}).get("status", "NONE"),
            "campaign_id": str(g(r, "campaign", "id")),
            "campaign_name": g(r, "campaign", "name"),
            "ad_group_id": str(g(r, "adGroup", "id")),
            "ad_group_name": g(r, "adGroup", "name"),
            "impressions": int(m.get("impressions") or 0),
            "clicks": int(m.get("clicks") or 0),
            "cost": round((m.get("costMicros") or 0) / 1_000_000, 2),
            "conversions": round(float(m.get("conversions") or 0), 2),
            "conv_value": round(float(m.get("conversionsValue") or 0), 2),
        })
    return terms
