# JevAds — Negative Keyword Architecture & Search Term Triage

*Last updated: 2026-10-01*

## What it does

1. **See every negative keyword on an account** — shared negative lists (with their
   actual member keywords), campaign-level negatives, and ad group-level negatives,
   navigable as a campaign → ad group tree.
2. **Triage new search terms against them** — for each search term in the window,
   decide whether it is already blocked, should join an existing shared list, needs
   a campaign or ad group negative, or should be promoted to a keyword.

## Architecture

```
Browser (index.html, React 18 + Babel standalone)
   │  OAuth bearer token in localStorage
   ▼
FastAPI backend — api.py, port 8090
   ├── google_ads.py   → Google Ads REST API v25 (searchStream, GAQL)
   └── jev_triage.py   → JEV engine, port 8080 (/v1/systemone)
```

### Google Ads API version

Pinned to **v25** in `google_ads.py` (`API_VERSION`), reported by `/api/health`.

Only **major** versions appear in REST paths. Minor releases (v25.1, v25.2) apply
automatically to the same `/v25` endpoint — there is no `/v25.2` path. As of
2026-10-01, v25 (released 2026-07-22) is the latest published version and serves
the v25.2 feature set. A `/v26` path is routed at the gateway but is undocumented
and unreleased; do not move to it until it appears in the official release notes.

### Authentication

Pure OAuth 2.0 — the user signs in, the backend exchanges the code, and every Ads
call rides on that user's bearer token. **No developer token**, no `google-ads.yaml`,
no service credentials on disk. `.env` needs only `GOOGLE_ADS_CLIENT_ID` and
`GOOGLE_ADS_CLIENT_SECRET`.

### What JEV actually is

`jev-server` (port 8080) is a **fast lexical scorer, not a machine-learning model**
— ~130 lines of Python with no ML dependencies and no model weights. Earlier
revisions of this document claimed a 500M-parameter transformer; that was not
accurate.

Its `choice` question type softmaxes a substring score (+3.0 if the whole choice
appears in the text, +1.5 per matching word). That is genuinely useful when the
choices are **real candidate strings**, and useless when they are abstract labels.
Measured: 0.96–0.99 confidence on true lexical matches, ~0.01 on non-matches,
200 decisions in 2.56 ms.

So the work is split:

| Job | Owner | Why |
|---|---|---|
| Nearest existing negative to a term | JEV `choice` | fuzzy, batched, fast |
| Waste vs. buyer vocabulary | JEV `choice` over a lexicon | same |
| "Send to human review" signal | JEV abstain band | principled, calibrated |
| Does an existing negative already block this term? | Python | exact match-type algebra, must not guess |
| Which level the negative belongs at | Python | structural rules on campaign/ad group spread |

`score` returns `(min+max)/2` regardless of input and is not used. `noul` carries a
shell-command safety vocabulary and is not relevant here.

## Triage outcomes

| Action | Meaning |
|---|---|
| `ALREADY_COVERED` | An existing negative blocks it; no spend leaking |
| `TIGHTEN_EXISTING` | A matching negative exists but is too narrow — still spending |
| `ADD_TO_SHARED_LIST` | Universal waste, or wasting across multiple campaigns |
| `ADD_CAMPAIGN_NEGATIVE` | Wasting across several ad groups in one campaign |
| `ADD_ADGROUP_NEGATIVE` | Isolated to one ad group — sculpt locally |
| `PROMOTE` | Converting; consider an exact-match keyword |
| `REVIEW` | Commercial intent with spend but no conversions, or JEV abstained |
| `INSUFFICIENT_DATA` | Below the click/cost floor |

## Endpoints (port 8090)

| Endpoint | Purpose |
|---|---|
| `GET /` | The web app |
| `GET /api/health` | Status, API version, JEV reachability |
| `GET /api/auth/login` | Redirect to Google OAuth |
| `GET /api/auth/callback` | Code → token exchange, stores session |
| `POST /api/auth/refresh` | Renew an access token from a refresh token |
| `POST /api/accounts` | Discover accessible accounts + MCC hierarchy |
| `POST /api/negatives` | Every negative on the account, by level |
| `POST /api/triage` | Negatives + JEV-routed search term recommendations |

## Files

| File | Role |
|---|---|
| `api.py` | FastAPI backend, OAuth, endpoints |
| `google_ads.py` | Google Ads REST client (v25), GAQL queries |
| `jev_triage.py` | Lexicon, JEV calls, match-type algebra, placement rules |
| `index.html` | Single-file React UI |
| `cli_pipeline.py` | Headless run for CI; needs a refresh token |
| `generate_refresh_token.py` | One-off refresh token generator for the CLI |
| `src/worker.js` | Cloudflare Worker — **stale**, see below |

## Services

```
jev-server.service    port 8080   JEV decision engine
jev-ads-api.service   port 8090   this backend
```

## Known gaps

Tracked in [ROADMAP.md](ROADMAP.md). In short: the account picker is flat rather
than showing the MCC hierarchy, nothing writes back to Google Ads yet, the intent
lexicon is generic, and `src/worker.js` is stale.
