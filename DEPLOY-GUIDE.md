# KRYV-MCP Complete Deployment Guide
# File: DEPLOY-GUIDE.md
# Phone-only. No PC. No Termux. All free.

---

## ARCHITECTURE OVERVIEW

```
[mcp.kryv.network]          ← Vercel (frontend + admin dashboard)
[mcp.kryv.network/mcp]      ← Cloudflare Workers (MCP server)
[Oracle Cloud Free Tier]    ← PostgreSQL database (clients, logs)
[Cloudflare KV]             ← Fast key-value cache (sessions)
[Google Sheets API]         ← Live data source bridge
```

---

## STEP 1 — CLOUDFLARE WORKERS (MCP Server)
**Time: 10 minutes**

1. Open phone browser → workers.cloudflare.com
2. Sign in (free account)
3. Click "Workers & Pages" → "Create" → "Hello World" → TypeScript
4. Name it: `kryv-mcp`
5. Click "Edit Code" (online editor opens)
6. DELETE everything in the editor
7. PASTE the entire contents of `mcp-server-index.ts`
8. Click "Deploy"

### Add Secrets (Settings → Variables → Add):
- `GOOGLE_SHEETS_API_KEY` = your Google Sheets API key
- `KRYV_API_SECRET` = make up any strong password
- `ORACLE_DB_URL` = your Oracle ORDS URL (Step 3)

### Add Cloudflare KV (for storage):
1. In Cloudflare: Workers → KV → Create Namespace
2. Name it: `KRYV_KV`
3. Go to your Worker → Settings → Variables → KV Namespace Bindings
4. Add binding: Variable name = `KRYV_KV`, Namespace = the one you created

### Add Custom Domain:
1. Worker → Settings → Triggers → Custom Domains
2. Add: `mcp.kryv.network`
(Cloudflare will auto-configure this if kryv.network uses Cloudflare nameservers)

### Fallback URL (if custom domain fails):
Your worker auto-gets: `kryv-mcp.yourname.workers.dev`
Update `manifest.json` and `index.html` to use that URL.

### TEST IT:
Open browser: `https://mcp.kryv.network/health`
You should see:
```json
{ "status": "ok", "server": "KRYV-MCP", "version": "0.1.0" }
```

---

## STEP 2 — VERCEL (Frontend + Admin)
**Time: 5 minutes — Already connected**

Upload these files to your GitHub repo `kryv-mcp`:
- `index.html` → main landing page
- `admin-dashboard.html` → your admin panel
- `manifest.json` → PWA config
- `favicon.ico` → your logo
- `sw.js` → service worker
- `llms.txt` → AI guide
- `oracle-setup.sql` → reference only, don't deploy

Vercel auto-deploys on every GitHub push. Done.

**URL mapping:**
- `mcp.kryv.network` → index.html (landing page)
- `mcp.kryv.network/admin` → admin-dashboard.html

To set up `/admin` route in Vercel:
Create file `vercel.json` in your repo:
```json
{
  "rewrites": [
    { "source": "/admin", "destination": "/admin-dashboard.html" }
  ]
}
```

---

## STEP 3 — ORACLE CLOUD FREE (Database)
**Time: 20 minutes**

### Create Account:
1. cloud.oracle.com → Sign Up
2. Use a credit card (NOT charged — Always Free has no time limit)
3. Choose region: Mumbai (ap-mumbai-1) for India or us-ashburn-1

### Create Autonomous Database:
1. Oracle Cloud Console → Autonomous Database → Create
2. Choose: Transaction Processing OR JSON
3. Choose: Always Free (toggle it ON — important!)
4. Set password for ADMIN user (save it!)
5. Wait ~5 minutes for it to start

### Run SQL Setup:
1. Click your database → Database Actions → SQL
2. Paste the entire `oracle-setup.sql` file
3. Click Run All (▶▶)
4. All tables created!

### Enable REST (ORDS):
After running the SQL file, your tables are accessible at:
```
https://YOUR-DB-ID.adb.REGION.oraclecloudapps.com/ords/SCHEMA/clients/
```

Find this URL in:
Oracle Console → Your DB → Database Actions → REST → Copy URL

### Add to Cloudflare Worker:
Set secret: `ORACLE_DB_URL` = the URL above (without table name)

### Test Oracle:
```
GET https://your-instance.adb.region.oraclecloudapps.com/ords/kryv/clients/
```
Should return JSON with your clients.

---

## STEP 4 — GOOGLE SHEETS API
**Time: 10 minutes**

1. console.cloud.google.com → New Project → "kryv-mcp"
2. Enable APIs → Search "Google Sheets API" → Enable
3. Credentials → Create Credentials → API Key
4. Copy the key → Add to Cloudflare Worker as `GOOGLE_SHEETS_API_KEY`

### Test with a Sheet:
1. Create a Google Sheet with sales data
2. Make it public (Share → Anyone with link can view)
3. Copy the Sheet ID from URL:
   `https://docs.google.com/spreadsheets/d/SHEET_ID_IS_HERE/edit`
4. Test via Admin Dashboard → Live Query → Fetch Sheet

---

## STEP 5 — CONNECT CLAUDE (OPTIONAL BUT COOL)
**Time: 2 minutes**

Claude Desktop (if you have a PC):
- Settings → Developer → MCP Servers → Add
- URL: `https://mcp.kryv.network/mcp`

Claude in browser — currently limited. But any client that supports
remote MCP servers can connect using your URL.

---

## COST SUMMARY

| Service | Free Tier Limit | Paid After |
|---------|----------------|------------|
| Cloudflare Workers | 100,000 req/day | $5/mo for 10M req |
| Cloudflare KV | 100,000 reads/day | $0.50/M reads |
| Vercel | Unlimited static | $20/mo for advanced |
| Oracle Autonomous DB | 20GB, Always Free | No limits hit typically |
| Google Sheets API | 500 req/100 sec | $0.006/1000 req after |
| **TOTAL** | **$0/month** | **~$5-10/month at scale** |

---

## MONETIZATION — HOW TO CHARGE CLIENTS

### Price in USD:
- Free tier: $0 (1 sheet, 100K req/day)
- Pro: $5/month per client (3 sources, VIGILIS)
- Enterprise: $50/month + $50 setup (custom sources, SLA)

### Payment:
- Use Razorpay (India) or Stripe for billing
- Manual for first 5-10 clients (just send UPI/PayPal)
- Generate API keys via Admin Dashboard → Clients → Add Client

### First Sale Script:
"I can connect your Google Sheet to Claude/ChatGPT so it never
guesses your data. $50 setup + $5/month. 10 minute install."

---

## FILES SUMMARY

| File | Deploy to |
|------|-----------|
| mcp-server-index.ts | Cloudflare Workers (paste in editor) |
| index.html | Vercel (via GitHub) |
| admin-dashboard.html | Vercel (via GitHub) |
| manifest.json | Vercel (via GitHub) |
| favicon.ico | Vercel (via GitHub) |
| sw.js | Vercel (via GitHub) |
| llms.txt | Vercel (via GitHub) |
| vercel.json | Vercel (via GitHub) |
| oracle-setup.sql | Oracle Cloud SQL Worksheet (run once) |
| package.json | GitHub only (reference) |
| wrangler.toml | Reference only (not needed for manual deploy) |

---

## TROUBLESHOOTING

**Server returns 404:**
Make sure Worker is deployed and URL is correct.
Test: open `mcp.kryv.network/health` in browser.

**CORS errors in admin dashboard:**
Worker has CORS headers set. If still failing, check the URL.

**Oracle connection fails:**
Make sure ORDS is enabled and table REST is enabled.
Check the SQL setup ran successfully.

**Google Sheets returns 403:**
Sheet must be set to "Anyone with link can view".
API key must have Sheets API enabled.

**Vercel shows old files:**
Push to GitHub → Vercel auto-deploys. Check Vercel dashboard.
