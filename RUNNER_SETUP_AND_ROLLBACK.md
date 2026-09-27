# GitHub Self-Hosted Runner — Transparency, Setup & 100% Rollback Guide

---

## 1. What is the GitHub Self-Hosted Runner?
A **self-hosted runner** is a standalone application downloaded into an isolated user directory (`~/actions-runner`). It connects outbound to GitHub via HTTPS (long-polling) to listen for jobs triggered in your `jev-ads-scrubber` repository.

### 🛡️ What It Touches on Your System:
• **Isolated Directory:** All binaries, logs, and work files reside strictly inside `~/actions-runner/`.
• **No Root / System Alterations:** It runs under your normal user (`apv`), requiring zero modifications to `/etc`, system packages, or kernel settings.
• **No Inbound Open Ports:** It makes outbound HTTPS connections to GitHub only; it does not open any listening ports on your router or firewall.

---

## 2. Installation & Setup Steps

If you choose to install the runner:

```bash
# 1. Create isolated runner directory
mkdir -p ~/actions-runner && cd ~/actions-runner

# 2. Download official GitHub Actions runner package (ARM64 for Pi 5)
curl -o actions-runner-linux-arm64.tar.gz -L https://github.com/actions/runner/releases/download/v2.322.0/actions-runner-linux-arm64-2.322.0.tar.gz

# 3. Extract the installer
tar xzf ./actions-runner-linux-arm64.tar.gz

# 4. Configure runner with your GitHub repo token (from repo Settings -> Actions -> Runners)
./config.sh --url https://github.com/anirudhpv/jev-ads-scrubber --token <YOUR_RUNNER_REGISTRATION_TOKEN>

# 5. Run the runner (interactive mode)
./run.sh
```

---

## 3. Complete 100% Clean Rollback & Uninstallation

If you ever want to completely remove the runner and leave **zero trace** on your Raspberry Pi:

### Step 1: Unregister from GitHub
```bash
cd ~/actions-runner
# Use the removal token generated in GitHub Settings -> Actions -> Runners -> Remove
./config.sh remove --token <YOUR_RUNNER_REMOVAL_TOKEN>
```

### Step 2: Stop and Remove Any Background Service (if installed)
```bash
cd ~/actions-runner
sudo ./svc.sh stop 2>/dev/null || true
sudo ./svc.sh uninstall 2>/dev/null || true
```

### Step 3: Delete the Entire Directory
```bash
rm -rf ~/actions-runner
```

### Verification:
```bash
# Verify no runner processes are active
pgrep -f "actions-runner" || echo "Runner completely removed. Zero active processes."
```

---

## 4. Rollback Guide for All Jev Local Services

If you ever want to completely uninstall the local Jev server and Ads API:

```bash
# 1. Stop and disable systemd user services
systemctl --user stop jev-server.service jev-ads-api.service
systemctl --user disable jev-server.service jev-ads-api.service

# 2. Delete service definition files
rm -f ~/.config/systemd/user/jev-server.service ~/.config/systemd/user/jev-ads-api.service
systemctl --user daemon-reload

# 3. Delete project directories (optional)
# rm -rf /home/apv/projects/jev-server
# rm -rf /home/apv/projects/jev-ads-scrubber
```
