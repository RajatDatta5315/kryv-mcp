# KRYV-MCP Full Deploy Guide
# File: DEPLOY-FULL.md
# Phone only. Everything step by step.

---

## PART 1 — CLOUDFLARE D1 DATABASE (5 min)

1. Open phone browser → dash.cloudflare.com
2. Left sidebar → D1 → Create Database
3. Name: **kryv-mcp-db** → Create
4. You'll see a Database ID (looks like: abc123-def456...) → COPY IT
5. Click the database → Console tab
6. Paste the entire `d1-schema.sql` file content
7. Click Run All
8. You should see "5 tables created" and "1 row inserted"

Done. You have a real SQLite database in Cloudflare.

---

## PART 2 — CLOUDFLARE KV (2 min)

1. Cloudflare Dashboard → Workers & Pages → KV
2. Create Namespace → Name: **KRYV_KV** → Add
3. Copy the ID shown next to KRYV_KV

---

## PART 3 — CLOUDFLARE WORKER (GitHub connected, 10 min)

### Connect GitHub repo:
1. Cloudflare Dashboard → Workers & Pages → Create
2. Click → **Connect to Git**
3. Authorize GitHub → Select repo: **kryv-mcp**
4. Branch: **main**
5. Build settings:
   - Framework: None
   - Build command: (leave blank)
   - Deploy command: (leave blank)
6. → Save and Deploy

### Update wrangler.toml (paste your real IDs):
Open `wrangler.toml` in your GitHub repo (edit on GitHub mobile):
- Replace `REPLACE_WITH_YOUR_D1_ID` with your D1 database ID
- Replace `REPLACE_WITH_YOUR_KV_ID` with your KV namespace ID
- Commit → Cloudflare auto-redeploys

### Add Secrets (Environment Variables):
Cloudflare Dashboard → Your Worker → Settings → Variables → Add:
| Name | Value |
|------|-------|
| KRYV_SECRET | make up a strong password |
| GOOGLE_SHEETS_KEY | your Google API key (or skip for now) |
| ORACLE_AGENT_URL | your Oracle VM URL (or skip for now) |

### Add Custom Domain (no nameserver change needed):
Option A — If kryv.network is on Cloudflare nameservers:
1. Worker → Settings → Triggers → Custom Domains
2. Add: mcp.kryv.network → done

Option B — kryv.network on Hostinger (keep it there):
Your worker gets a free URL: **kryv-mcp.YOURNAME.workers.dev**
Use this URL in all your files instead of mcp.kryv.network.
To proxy through Vercel:
- In `vercel.json` add:
```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://kryv-mcp.YOURNAME.workers.dev/:path*" }
  ]
}
```
Now `mcp.kryv.network/api/mcp` → Cloudflare Worker. Clean.

### Test:
Open browser: https://kryv-mcp.YOURNAME.workers.dev/health
You should see:
```json
{ "status": "ok", "db": "connected", "server": "KRYV-MCP" }
```

---

## PART 4 — ORACLE VM AGENT (15 min, optional)

Skip this initially. Add later for deep local data collection.

### Create Oracle Always-Free VM:
1. cloud.oracle.com → Sign up (credit card required, never charged)
2. Choose region: ap-mumbai-1 (India) or us-ashburn-1
3. Compute → Instances → Create Instance
4. Shape: Ampere A1 (ARM) → Always Free eligible → 1 OCPU, 6GB RAM
5. Add SSH key (generate one at sshkeygen.com on your phone)
6. Create → Wait 3 minutes

### Connect and setup:
Get the public IP from Oracle Console.
Use JuiceSSH app (Android) or Termius (iOS) to SSH:
```
ssh ubuntu@YOUR_ORACLE_IP
```

Install and run the agent:
```bash
sudo apt update && sudo apt install python3-pip -y
pip3 install requests schedule --break-system-packages
# Upload oracle-agent.py (use GitHub → clone on server)
git clone https://github.com/YOURNAME/kryv-mcp.git
cd kryv-mcp
export KRYV_CLIENT_ID=your-client-id
export KRYV_SERVER=https://kryv-mcp.YOURNAME.workers.dev
python3 oracle-agent.py
```

### Make it always-on (systemd):
```bash
sudo nano /etc/systemd/system/kryv-agent.service
```
Paste the systemd config from oracle-agent.py comments, then:
```bash
sudo systemctl enable kryv-agent
sudo systemctl start kryv-agent
sudo systemctl status kryv-agent
```

---

## PART 5 — CHROME EXTENSION (10 min)

### Package the extension files:
These files must be in ONE folder (no subfolders):
- ext-manifest.json → rename to manifest.json
- ext-background.js → keep name
- ext-whatsapp.js → keep name
- ext-popup.html → keep name
- favicon.ico → copy your favicon

### Install in Chrome:
1. Chrome → chrome://extensions
2. Enable "Developer mode" (top right toggle)
3. "Load unpacked" → select your extension folder
4. KRYV-MCP Context Bridge appears in extensions

### On phone (Android Chrome):
Chrome mobile doesn't support extensions.
Use Kiwi Browser (from Play Store) — it supports Chrome extensions.
1. Install Kiwi Browser
2. Kiwi → Extensions → From store → "load unpacked"

### Configure:
Click extension icon → popup opens:
1. Enter your Client ID (from admin dashboard → Clients)
2. Enter Server URL (your workers.dev URL)
3. Toggle ON
4. Click "Save & Sync Now"
5. Click "Test Connection" — should show green

---

## PART 6 — NEHIRA INTEGRATION

1. Copy `nehira-mcp-connector.ts` into your NEHIRA project
2. In NEHIRA's main chat function, before calling your LLM:

```typescript
import { enrichContext, buildNehiraPrompt } from "./nehira-mcp-connector";

const context = await enrichContext(userMessage, {
  serverUrl: "https://kryv-mcp.YOURNAME.workers.dev/mcp",
  clientId: user.kryvClientId,
  enabled: user.kryvEnabled,
  vigilisFirst: true,
  contextSources: ["browser_tabs", "local_notes", "whatsapp"],
});

const { system, user } = buildNehiraPrompt(userMessage, context);
// pass system + user to your LLM call
```

3. Add KRYV settings panel to NEHIRA's settings page
   (see NEHIRA_SETTINGS_TEMPLATE in nehira-mcp-connector.ts)

---

## ALL FILES — UPLOAD TO GITHUB kryv-mcp REPO

| File in this chat | Upload as |
|-------------------|-----------|
| mcp-worker.ts | mcp-worker.ts |
| d1-schema.sql | d1-schema.sql |
| wrangler.toml | wrangler.toml |
| ext-manifest.json | ext-manifest.json |
| ext-background.js | ext-background.js |
| ext-whatsapp.js | ext-whatsapp.js |
| ext-popup.html | ext-popup.html |
| oracle-agent.py | oracle-agent.py |
| nehira-mcp-connector.ts | nehira-mcp-connector.ts |
| index.html | index.html |
| admin-dashboard.html | admin-dashboard.html |
| manifest.json | manifest.json |
| sw.js | sw.js |
| llms.txt | llms.txt |
| vercel.json | vercel.json |
| favicon.ico | favicon.ico (your logo) |

Vercel deploys: index.html, admin-dashboard.html, sw.js, manifest.json, llms.txt
Cloudflare deploys: mcp-worker.ts (via wrangler.toml)
Manual run: oracle-agent.py (on Oracle VM)
Manual install: ext-* files (Chrome extension)

---

## COSTS

Everything below is $0/month until serious scale:

| Service | Free Limit | Cost After |
|---------|-----------|------------|
| Cloudflare Workers | 100K req/day | $5/mo for 10M |
| Cloudflare D1 | 5M reads/day | $0.001/M after |
| Cloudflare KV | 100K reads/day | $0.50/M after |
| Vercel | Unlimited static | $20/mo pro |
| Oracle VM | Always free (4 core, 24GB) | $0 forever |
| Chrome Extension | Free | $5 one-time store fee |
| **TOTAL** | **$0/mo** | |

---

## MONETIZATION

Charge in USD. Price by value, not by your cost.

Free: Self-host, bring your own Cloudflare (for developers)
Pro: $5/month — hosted, Chrome Extension, 3 context sources
Business: $20/month — VIGILIS, unlimited sources, NEHIRA integration
Enterprise: $50 setup + $50/month — custom data sources, SLA, white-label
