# JevAds & TypeSafe Jev — Complete Project & System Documentation

*Last Updated: 2026-09-27*

---

## 1. System Architecture Overview

This project implements a **sub-millisecond Google Ads negative keyword and search intent scrubber** powered by **TypeSafe Jev (System 1 Decision Architecture)** running on a Raspberry Pi 5.

```
┌─────────────────────────────────────────────────────────────┐
│                      Google Ads Account                     │
│  (Search Terms Report, Targeted KWs, Negative Lists, RSAs)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│           Google Ads API Client (v25.2 / Python SDK)        │
│          (google_ads_service.py / api.py @ Port 8090)       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             TypeSafe Jev Decision Engine (Port 8080)        │
│           (server.py / jev-server.service @ 0.01ms CPU)     │
│   • noul: Safe vs Harmful / Commercial Intent Gate          │
│   • choice: 4-Way Routing (Shared Neg, AG Neg, Promote, Review)│
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Output Actions & Export                     │
│   1. Direct 1-Click Mutation via Google Ads API             │
│   2. Formatted Google Ads Editor CSV Download               │
│   3. Interactive Web Review Dashboard (index.html)          │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Directory & File Inventory on the Pi

### A. Jev System 1 Decision Engine (`/home/apv/projects/jev-server/`)
• `server.py`: FastAPI server implementing the `/v1/systemone` wire protocol (`noul`, `choice`, `score`).
• `jev_cli.py`: Command-line interface for querying Jev decisions from bash scripts or terminal.
• `venv/`: Isolated Python virtual environment with `fastapi`, `uvicorn`, `pydantic`, `httpx`.
• `~/.config/systemd/user/jev-server.service`: Background user service keeping Jev listening on `0.0.0.0:8080`.

### B. Google Ads Scrubber Application (`/home/apv/projects/jev-ads-scrubber/`)
• `index.html`: High-density web application with live account discovery, keyword matrix, and review table.
• `google_ads_service.py`: Google Ads API (v25.2) client handling GAQL queries for search terms, negatives, and keywords.
• `api.py`: FastAPI backend bridging the web interface with Google Ads and Jev.
• `cli_pipeline.py`: Headless CLI and CI/CD runner script for batch processing without a browser.
• `.github/workflows/study_and_scrub.yml`: GitHub Actions workflow enabling cloud runs using GitHub Secrets.
• `~/.config/systemd/user/jev-ads-api.service`: Background user service for the ads API backend on port `8090`.

---

## 3. Network Ports & Services

| Service | Port | Protocol | Purpose | Status |
|---|---|---|---|---|
| **Jev Engine** | `8080` | HTTP / REST | `/v1/systemone` probabilistic decision endpoint | Active (`jev-server.service`) |
| **Ads API Backend** | `8090` | HTTP / REST | Google Ads GAQL data extraction & mutation | Active (`jev-ads-api.service`) |
| **Local Web Server** | `80` / `8765` | HTTP / Web | Serves `http://apv1.local/jev_ads.html` | Active |

---

## 4. Git Repositories

• **JevAds Scrubber:** `https://github.com/anirudhpv/jev-ads-scrubber` (`main` branch)
• **Local Path:** `/home/apv/projects/jev-ads-scrubber`
• **Deploy Key:** `~/.ssh/deploy_jev_ads` configured under host alias `github-jev-ads`
