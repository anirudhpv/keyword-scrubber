"""Search-term triage: route new search terms to the right negative level.

Division of labour:
  * JEV (/v1/systemone, `choice`) does the fuzzy lexical scoring - which
    existing negative does this term most resemble, and which intent
    vocabulary does it hit. It is fast and batched, and its abstain band
    gives us a principled "send to human review" signal.
  * Plain Python does the exact match-type algebra and the structural
    placement rules, because those are deterministic and must not guess.
"""
import os
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

import requests

JEV_URL = os.getenv("JEV_URL", "http://localhost:8080").rstrip("/")

# JEV's choice scorer is O(choices) per question; keep the shortlist tight so
# the signal is not drowned out by dozens of non-matching candidates.
MAX_CANDIDATES = 25

# Intent vocabulary. JEV scores the raw tokens (its scorer matches substrings),
# and we map the winning token back to its group here.
LEXICON: Dict[str, List[str]] = {
    "employment": [
        "jobs", "job", "career", "careers", "salary", "salaries", "hiring",
        "vacancy", "resume", "internship", "recruitment", "apprenticeship",
    ],
    "informational": [
        "what is", "how to", "tutorial", "guide", "meaning", "definition",
        "wikipedia", "examples", "example", "explained", "vs", "difference",
    ],
    "freebie": [
        "free", "freeware", "cheap", "cheapest", "discount", "coupon",
        "crack", "cracked", "torrent", "pirated", "download", "pdf",
        "template", "templates", "sample", "trial version",
    ],
    "support": [
        "login", "log in", "sign in", "customer service", "complaint",
        "cancel", "refund", "scam", "lawsuit", "contact number",
    ],
    "commercial": [
        "buy", "purchase", "pricing", "price", "cost", "quote", "demo",
        "hire", "agency", "consultant", "vendor", "supplier", "company",
        "near me", "best", "top rated", "software", "platform", "solution",
        "enterprise", "for business",
    ],
}

# Groups that represent waste anywhere in the account, not just in one ad
# group - these are the ones that belong on a shared list.
UNIVERSAL_WASTE = {"employment", "informational", "freebie", "support"}
WASTE_GROUPS = UNIVERSAL_WASTE
BUYER_GROUPS = {"commercial"}

_TOKEN_GROUP = {tok: grp for grp, toks in LEXICON.items() for tok in toks}
_ALL_TOKENS = list(_TOKEN_GROUP.keys())


class JevUnavailable(RuntimeError):
    pass


def jev_health() -> Dict[str, Any]:
    try:
        r = requests.get(f"{JEV_URL}/health", timeout=3)
        r.raise_for_status()
        return {"reachable": True, **r.json()}
    except Exception as e:
        return {"reachable": False, "error": str(e)}


def jev_choice(questions: List[Dict[str, Any]], timeout: int = 30) -> Dict[str, Any]:
    """Send a batch of `choice` questions to JEV. Returns {id: DecisionResult}."""
    if not questions:
        return {}
    try:
        r = requests.post(
            f"{JEV_URL}/v1/systemone",
            json={"questions": questions, "temperature": 0.0},
            timeout=timeout,
        )
        r.raise_for_status()
        body = r.json()
    except Exception as e:
        raise JevUnavailable(f"JEV engine unreachable at {JEV_URL}: {e}")
    return {res["id"]: res for res in body.get("results", [])}


# --- Match-type algebra (deterministic) --------------------------------------

def _tokens(text: str) -> List[str]:
    return [t for t in "".join(c if c.isalnum() else " " for c in text.lower()).split() if t]


def blocks(negative_text: str, match_type: str, term: str) -> bool:
    """Does this existing negative already block this search term?"""
    neg_toks = _tokens(negative_text)
    term_toks = _tokens(term)
    if not neg_toks:
        return False

    mt = (match_type or "BROAD").upper()
    if mt == "EXACT":
        return neg_toks == term_toks
    if mt == "PHRASE":
        n = len(neg_toks)
        return any(term_toks[i:i + n] == neg_toks for i in range(len(term_toks) - n + 1))
    # BROAD negatives block when every token is present, in any order.
    return all(t in term_toks for t in neg_toks)


def _shortlist(term: str, negatives: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Negatives sharing at least one token with the term, best overlap first."""
    term_toks = set(_tokens(term))
    scored = []
    for neg in negatives:
        overlap = len(term_toks & set(_tokens(neg["text"])))
        if overlap:
            scored.append((overlap, neg))
    scored.sort(key=lambda x: -x[0])
    return [n for _, n in scored[:MAX_CANDIDATES]]


# --- Triage ------------------------------------------------------------------

def _aggregate(search_terms: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Collapse per-ad-group rows into one record per search term."""
    buckets: Dict[str, Dict[str, Any]] = {}
    for row in search_terms:
        term = (row.get("term") or "").strip()
        if not term:
            continue
        b = buckets.setdefault(term, {
            "term": term,
            "impressions": 0, "clicks": 0, "cost": 0.0,
            "conversions": 0.0, "conv_value": 0.0,
            "campaigns": {}, "ad_groups": {}, "statuses": set(),
        })
        b["impressions"] += row.get("impressions", 0)
        b["clicks"] += row.get("clicks", 0)
        b["cost"] += row.get("cost", 0.0)
        b["conversions"] += row.get("conversions", 0.0)
        b["conv_value"] += row.get("conv_value", 0.0)
        b["statuses"].add(row.get("status", "NONE"))
        if row.get("campaign_id"):
            b["campaigns"][row["campaign_id"]] = row.get("campaign_name", "")
        if row.get("ad_group_id"):
            b["ad_groups"][row["ad_group_id"]] = {
                "name": row.get("ad_group_name", ""),
                "campaign_id": row.get("campaign_id", ""),
                "campaign_name": row.get("campaign_name", ""),
            }

    out = []
    for b in buckets.values():
        b["cost"] = round(b["cost"], 2)
        b["conversions"] = round(b["conversions"], 2)
        b["conv_value"] = round(b["conv_value"], 2)
        b["excluded"] = "EXCLUDED" in b["statuses"]
        b["statuses"] = sorted(b["statuses"])
        out.append(b)
    out.sort(key=lambda x: -x["cost"])
    return out


def _flatten_negatives(negatives: Dict[str, Any]) -> List[Dict[str, Any]]:
    """One flat list of every negative, tagged with where it lives."""
    flat = []
    for sl in negatives.get("shared_lists", []):
        for kw in sl["keywords"]:
            flat.append({
                "text": kw["text"], "match_type": kw["match_type"],
                "level": "SHARED_LIST", "container_id": sl["id"],
                "container_name": sl["name"],
                "scope_campaigns": [c["campaign_id"] for c in sl["applied_campaigns"]],
            })
    for cn in negatives.get("campaign_negatives", []):
        flat.append({
            "text": cn["text"], "match_type": cn["match_type"],
            "level": "CAMPAIGN", "container_id": cn["campaign_id"],
            "container_name": cn["campaign_name"],
            "scope_campaigns": [cn["campaign_id"]],
        })
    for an in negatives.get("adgroup_negatives", []):
        flat.append({
            "text": an["text"], "match_type": an["match_type"],
            "level": "AD_GROUP", "container_id": an["ad_group_id"],
            "container_name": an["ad_group_name"],
            "scope_campaigns": [an["campaign_id"]],
        })
    return [n for n in flat if n["text"]]


def triage(
    search_terms: List[Dict[str, Any]],
    negatives: Dict[str, Any],
    min_clicks: int = 2,
    min_cost: float = 0.0,
) -> Dict[str, Any]:
    """Classify each search term and recommend where its negative belongs."""
    aggregated = _aggregate(search_terms)
    flat_negs = _flatten_negatives(negatives)

    # Pass 1 - deterministic coverage check against existing negatives.
    coverage: Dict[str, Optional[Dict[str, Any]]] = {}
    for rec in aggregated:
        hit = None
        for neg in flat_negs:
            if blocks(neg["text"], neg["match_type"], rec["term"]):
                # A negative only counts if it actually applies where the term ran.
                if not neg["scope_campaigns"] or set(neg["scope_campaigns"]) & set(rec["campaigns"]):
                    hit = neg
                    break
        coverage[rec["term"]] = hit

    # Pass 2 - batch every JEV question in one round trip.
    questions: List[Dict[str, Any]] = []
    qmap: Dict[str, Tuple[str, str]] = {}

    for i, rec in enumerate(aggregated):
        term = rec["term"]
        if coverage[term]:
            continue  # already blocked; nothing to route

        intent_id = f"i{i}"
        questions.append({
            "id": intent_id, "type": "choice",
            "question": term, "choices": _ALL_TOKENS,
        })
        qmap[intent_id] = ("intent", term)

        shortlist = _shortlist(term, flat_negs)
        if shortlist:
            near_id = f"n{i}"
            questions.append({
                "id": near_id, "type": "choice",
                "question": term,
                "choices": [n["text"] for n in shortlist],
            })
            qmap[near_id] = ("near", term)

    jev_results = jev_choice(questions) if questions else {}
    jev_latency = 0.0

    intent_by_term: Dict[str, Dict[str, Any]] = {}
    near_by_term: Dict[str, Dict[str, Any]] = {}
    for qid, res in jev_results.items():
        kind, term = qmap[qid]
        jev_latency += res.get("latency_ms", 0.0)
        (intent_by_term if kind == "intent" else near_by_term)[term] = res

    # Pass 3 - placement.
    recommendations = []
    for rec in aggregated:
        recommendations.append(
            _recommend(rec, coverage[rec["term"]], intent_by_term.get(rec["term"]),
                       near_by_term.get(rec["term"]), flat_negs, min_clicks, min_cost)
        )

    buckets = defaultdict(list)
    for r in recommendations:
        buckets[r["action"]].append(r)

    return {
        "recommendations": recommendations,
        "summary": {
            "terms_analysed": len(aggregated),
            "jev_questions": len(questions),
            "jev_latency_ms": round(jev_latency, 2),
            "by_action": {k: len(v) for k, v in sorted(buckets.items())},
            "wasted_spend": round(
                sum(r["cost"] for r in recommendations
                    if r["action"] in ("ADD_TO_SHARED_LIST", "ADD_CAMPAIGN_NEGATIVE",
                                       "ADD_ADGROUP_NEGATIVE")), 2),
            "leaking_spend": round(
                sum(r["cost"] for r in recommendations if r["action"] == "TIGHTEN_EXISTING"), 2),
        },
    }


def _recommend(rec, covered, intent, near, flat_negs, min_clicks, min_cost) -> Dict[str, Any]:
    term = rec["term"]
    base = {
        "term": term,
        "impressions": rec["impressions"], "clicks": rec["clicks"],
        "cost": rec["cost"], "conversions": rec["conversions"],
        "conv_value": rec["conv_value"],
        "campaigns": [{"id": k, "name": v} for k, v in rec["campaigns"].items()],
        "ad_groups": [{"id": k, **v} for k, v in rec["ad_groups"].items()],
        "excluded": rec["excluded"],
        "confidence": 0.0, "jev_abstain": False,
        "matched_negative": None, "intent_group": None,
    }

    # Already blocked by an existing negative.
    if covered:
        base["matched_negative"] = {
            "text": covered["text"], "match_type": covered["match_type"],
            "level": covered["level"], "container_name": covered["container_name"],
        }
        # Still spending despite a matching negative means the negative is scoped
        # or match-typed too narrowly to catch this variant.
        if rec["cost"] > 0 or rec["clicks"] > 0:
            base.update({
                "action": "TIGHTEN_EXISTING",
                "reason": (
                    f'Still spending despite {covered["match_type"]} negative '
                    f'"{covered["text"]}" on {covered["level"].replace("_", " ").lower()} '
                    f'"{covered["container_name"]}". Widen the match type or move it up a level.'
                ),
                "confidence": 1.0,
            })
        else:
            base.update({
                "action": "ALREADY_COVERED",
                "reason": f'Blocked by existing negative "{covered["text"]}" ({covered["match_type"]}).',
                "confidence": 1.0,
            })
        return base

    # Converting terms are never negative candidates.
    if rec["conversions"] > 0:
        base.update({
            "action": "PROMOTE",
            "reason": f'{rec["conversions"]:g} conversion(s) at ${rec["cost"]:.2f}. '
                      f'Consider promoting to an exact-match keyword.',
            "confidence": 1.0,
        })
        return base

    # Below the evidence floor - not enough data to act on yet.
    if rec["clicks"] < min_clicks and rec["cost"] <= min_cost:
        base.update({
            "action": "INSUFFICIENT_DATA",
            "reason": f'Only {rec["clicks"]} click(s) / ${rec["cost"]:.2f} spent. Not enough signal yet.',
            "confidence": 0.0,
        })
        return base

    intent_group = None
    if intent and not intent.get("abstain"):
        intent_group = _TOKEN_GROUP.get(intent.get("verdict", ""))
        base["confidence"] = intent.get("confidence", 0.0)
    base["intent_group"] = intent_group
    base["jev_abstain"] = bool(intent and intent.get("abstain"))

    # Ambiguous vocabulary, or buyer vocabulary with spend but no conversion -
    # both need a human.
    if intent_group is None or intent_group in BUYER_GROUPS:
        base.update({
            "action": "REVIEW",
            "reason": (
                f'Commercial intent ("{intent.get("verdict")}") but {rec["clicks"]} click(s) '
                f'and no conversions - check the landing page before excluding.'
                if intent_group in BUYER_GROUPS else
                f'No clear waste or buyer vocabulary matched; JEV abstained. '
                f'${rec["cost"]:.2f} spent over {rec["clicks"]} click(s).'
            ),
            "confidence": base["confidence"],
        })
        return base

    # Waste vocabulary - decide the level.
    token = intent.get("verdict", "")
    n_campaigns = len(rec["campaigns"])
    n_ad_groups = len(rec["ad_groups"])

    if intent_group in UNIVERSAL_WASTE:
        target = _best_shared_list(near, flat_negs)
        base.update({
            "action": "ADD_TO_SHARED_LIST",
            "suggested_keyword": token,
            "suggested_match_type": "PHRASE",
            "target": target,
            "reason": (
                f'"{token}" is universal {intent_group} waste'
                + (f' and this term ran in {n_campaigns} campaigns' if n_campaigns > 1 else '')
                + f'. ${rec["cost"]:.2f} spent, no conversions.'
                + (f' Closest existing list: "{target["container_name"]}".' if target else
                   ' No shared list matched - create one.')
            ),
        })
    elif n_campaigns > 1:
        base.update({
            "action": "ADD_TO_SHARED_LIST",
            "suggested_keyword": term,
            "suggested_match_type": "EXACT",
            "target": _best_shared_list(near, flat_negs),
            "reason": f'Wasting across {n_campaigns} campaigns - exclude once at account level.',
        })
    elif n_ad_groups > 1:
        cid, cname = next(iter(rec["campaigns"].items()))
        base.update({
            "action": "ADD_CAMPAIGN_NEGATIVE",
            "suggested_keyword": term,
            "suggested_match_type": "EXACT",
            "target": {"level": "CAMPAIGN", "container_id": cid, "container_name": cname},
            "reason": f'Wasting in {n_ad_groups} ad groups within "{cname}".',
        })
    else:
        ag_id, ag = next(iter(rec["ad_groups"].items()))
        base.update({
            "action": "ADD_ADGROUP_NEGATIVE",
            "suggested_keyword": term,
            "suggested_match_type": "EXACT",
            "target": {"level": "AD_GROUP", "container_id": ag_id,
                       "container_name": ag["name"]},
            "reason": f'Isolated to "{ag["name"]}" - sculpt locally so other ad groups keep the traffic.',
        })

    return base


def _best_shared_list(near, flat_negs) -> Optional[Dict[str, Any]]:
    """Use JEV's nearest-negative verdict to name the most likely destination list."""
    if not near or near.get("abstain"):
        return None
    verdict = near.get("verdict")
    for neg in flat_negs:
        if neg["text"] == verdict and neg["level"] == "SHARED_LIST":
            return {
                "level": "SHARED_LIST",
                "container_id": neg["container_id"],
                "container_name": neg["container_name"],
                "because_of": verdict,
                "confidence": near.get("confidence", 0.0),
            }
    return None
