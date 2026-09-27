# JevAds & TypeSafe Jev — Complete Project & System Documentation

*Last Updated: 2026-09-27*

---

## 1. System Architecture Overview

This project implements a **sub-millisecond Google Ads negative keyword and search intent scrubber** powered by **TypeSafe Jev (System 1 Decision Architecture)** running on a Raspberry Pi 5, with dual deployment modes (Local Server & Client-Side Browser WASM).

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Google Ads Account                            │
│  (Search Terms Report, Targeted KWs, Negative Lists, RSAs, Landing Page)│
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 Dual Decision Engine Architecture                       │
├────────────────────────────────────┬────────────────────────────────────┤
│   MODE A: Local Pi Engine (500MB)  │   MODE B: Client WASM Engine (20MB)│
│   • Runs on Raspberry Pi 5 CPU     │   • Downloaded from GitHub Pages   │
│   • Q4_K_M small transformer       │   • 22M parameter INT8 encoder     │
│   • For private automation & cron  │   • Zero server dependency         │
└────────────────────────────────────┴────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 4-Way Jev Decision Routing (0.01ms)                     │
│   1. 🌐 Shared Negative List (Universal waste: jobs, free, salary, pdf)│
│   2. 🎯 Ad Group Negative (Local traffic sculpting / intent mismatch)   │
│   3. 🟢 Promote to Keyword (High-intent commercial buyers)              │
│   4. 🟡 Human Review / Discovery Queue (Abstain band / new patterns)    │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Outputs & Execution                               │
│   • Direct 1-Click Mutation via Google Ads API v25.2                    │
│   • Formatted Google Ads Editor CSV Download                            │
│   • Real-Time Interactive Review Table (index.html)                     │
└─────────────────────────────────────────────────────────────────────────┘
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
• `api.py`: FastAPI backend bridging the web interface with Google Ads and Jev (Port `8090`).
• `cli_pipeline.py`: Headless CLI and CI/CD runner script for batch processing without a browser.
• `.github/workflows/study_and_scrub.yml`: GitHub Actions workflow enabling cloud runs using GitHub Secrets.
• `~/.config/systemd/user/jev-ads-api.service`: Background user service for the ads API backend on port `8090`.

---

## 3. Model Architecture & Size Mathematics

| Dimension | Pi 5 Local Engine | Browser WASM Engine |
|---|---|---|
| **Parameter Count** | ~500 Million (0.5B) | ~22 Million (0.022B) |
| **Quantization** | Q4_K_M (GGUF) | INT8 (1 byte per param) |
| **Size on Disk / Transfer** | **~350 MB – 500 MB** | **~20 MB – 22 MB** |
| **Execution Environment** | Pi 5 Cortex-A76 CPU | Client Browser Memory / WebGPU |
| **Network Requirement** | Local host / private LAN | 100% Offline after 1s load |
| **Cross-Industry Switching** | Dynamic context injection | Dynamic 50KB in-memory profile |

---

## 4. Network Ports & Services

| Service | Port | Protocol | Purpose | Status |
|---|---|---|---|---|
| **Jev Engine** | `8080` | HTTP / REST | `/v1/systemone` probabilistic decision endpoint | Active (`jev-server.service`) |
| **Ads API Backend** | `8090` | HTTP / REST | Google Ads GAQL data extraction & mutation | Active (`jev-ads-api.service`) |
| **Local Web Server** | `80` / `8765` | HTTP / Web | Serves `http://apv1.local/jev_ads.html` | Active |

---

## 5. Git Repositories

• **JevAds Scrubber:** `https://github.com/anirudhpv/jev-ads-scrubber` (`main` branch)
• **Local Path:** `/home/apv/projects/jev-ads-scrubber`
• **Deploy Key:** `~/.ssh/deploy_jev_ads` configured under host alias `github-jev-ads`
