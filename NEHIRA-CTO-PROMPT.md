# NEHIRA × KRYV-MCP Integration Brief
# File: NEHIRA-CTO-PROMPT.md
# Share this with your CTO. This is everything they need.

---

## WHAT IS KRYV-MCP

KRYV-MCP is a live MCP (Model Context Protocol) server running at:
- Frontend: https://mcp.kryv.network (Vercel)
- API: https://kryv-mcp.rajatdatta90000.workers.dev (Cloudflare Workers)
- Database: Cloudflare D1 (SQLite)

It is the context layer for NEHIRA. Before NEHIRA answers any question,
it asks KRYV-MCP: "what does this user's world look like right now?"
KRYV-MCP returns their real browser tabs, WhatsApp context, notes, files.
NEHIRA answers using that. Zero hallucination about personal data.

---

## WHAT IS ALREADY BUILT (KRYV side)

### 1. MCP Server (Cloudflare Workers — mcp-worker.ts)
Live at: https://kryv-mcp.rajatdatta90000.workers.dev

Endpoints:
- POST /mcp          → MCP JSON-RPC 2.0 (all tools)
- GET  /sse          → SSE stream (for MCP clients like Claude)
- POST /push         → Chrome Extension / Oracle agent pushes context here
- POST /nehira/connect → ONE-CLICK connect (explained below)
- GET  /health       → Server status check
- GET  /admin/*      → Admin API (protected by KRYV_SECRET header)

### 2. MCP Tools available to NEHIRA
Call these via POST /mcp with JSON-RPC:
- vigilis_check(query)             → threat/hallucination detection
- get_context(client_id, source?)  → get user's personal context
- push_context(client_id, source, data) → store new context
- ask_nehira(message, context?)    → bridge to NEHIRA API (for external callers)
- fetch_sheet(sheet_id, range)     → Google Sheets data
- cache_set(key, value, ttl)       → D1-based cache
- cache_get(key)                   → D1-based cache
- get_stats()                      → usage stats
- register_client(name, email)     → create new client
- server_info()                    → server metadata

### 3. NEHIRA Auto-Connect (no manual URL pasting)
POST https://kryv-mcp.rajatdatta90000.workers.dev/nehira/connect
Body: { "name": "User Name", "email": "user@email.com", "nehira_user_id": "uid123" }
Response: { "connected": true, "client_id": "uuid", "api_key": "kryv-sk-xxx", "mcp_url": "...", "push_url": "..." }

This registers the user in D1 and gives them a client_id.
One API call from NEHIRA. No user action needed.

### 4. D1 Database (Cloudflare — always free)
Tables:
- clients: name, email, api_key, plan, nehira_user_id
- context_store: client_id, source, data (JSON), updated_at
- usage_logs: tool_name, response_ms, status, created_at
- vigilis_incidents: risk_score, pattern, category
- kv_cache: key, value, expires_at
- data_sources: registered data sources per client

### 5. Chrome Extension (ext-*.js files)
- Reads browser tabs, history, WhatsApp Web DOM (with user permission)
- Pushes to POST /push every 5 minutes
- User gets a client_id from NEHIRA and enters it in extension popup
- All context lands in context_store with source = "browser_tabs" / "whatsapp_messages" / etc.

### 6. Oracle VM Agent (oracle-agent.py)
- Runs 24/7 on Oracle Always-Free VM (4 cores, 24GB RAM)
- Reads local files, notes, system info
- Pushes to /push endpoint
- Auto-restarts on crash (systemd + cron watchdog)
- Auto-updates from GitHub daily at 3am

### 7. NEHIRA Connector File (nehira-mcp-connector.ts)
- Ready-made TypeScript module for your NEHIRA codebase
- Call enrichContext(userMessage, config) before every LLM call
- Returns formatted context string to inject into prompt
- Handles VIGILIS check, context fetch, prompt building
- Has example code at bottom of file

---

## WHAT NEHIRA NEEDS TO BUILD (your CTO's job)

### 1. Auto-Connect on NEHIRA Login/Signup
When a user logs in or signs up to NEHIRA, make ONE API call:

```typescript
const res = await fetch('https://kryv-mcp.rajatdatta90000.workers.dev/nehira/connect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: user.displayName,
    email: user.email,
    nehira_user_id: user.id,
  }),
});
const kryv = await res.json();
// Store kryv.client_id and kryv.api_key in user profile
user.kryvClientId = kryv.client_id;
user.kryvApiKey = kryv.api_key;
```

That's it. User is connected. No UI needed. No URL paste. Automatic.

### 2. Inject Context Before Every LLM Call
In NEHIRA's main chat handler, before calling your LLM:

```typescript
import { enrichContext, buildNehiraPrompt } from './nehira-mcp-connector';

async function handleMessage(userMessage: string, user: User) {
  // Fetch grounded context from KRYV
  const context = await enrichContext(userMessage, {
    serverUrl: 'https://kryv-mcp.rajatdatta90000.workers.dev/mcp',
    clientId: user.kryvClientId,
    enabled: true,
    vigilisFirst: true,  // VIGILIS screens every message
    contextSources: ['browser_tabs', 'whatsapp_messages', 'local_notes'],
  });

  // VIGILIS blocked it — return warning
  if (context.vigilis && !context.vigilis.safe && context.vigilis.risk_score > 0.7) {
    return { reply: '⚠ NEHIRA detected a threat in this message. Blocked by VIGILIS.', blocked: true };
  }

  // Build grounded prompt
  const { system, user: userPrompt } = buildNehiraPrompt(userMessage, context,
    'You are NEHIRA, a helpful AI. Use personal context when available.'
  );

  // Call your existing LLM with grounded prompt
  const reply = await yourLLM.chat({ system, message: userPrompt });
  return { reply, grounded: context.grounded, sources: context.sources };
}
```

### 3. KRYV Settings Panel in NEHIRA UI
Add a "Connectors" or "Integrations" section in NEHIRA settings.
Show the user:
- KRYV-MCP: Connected ✓ (auto-connected on login)
- Which context sources are active (browser_tabs, whatsapp, notes, files)
- Toggle to enable/disable each source
- Link to install Chrome Extension
- Privacy mode toggle (if on, context never leaves their device)

No manual URL paste. No API key copy. It's all handled by /nehira/connect.

### 4. Store KRYV client_id in User Profile
In your users table / auth system, add two fields:
- kryv_client_id (from /nehira/connect response)
- kryv_connected (boolean)

On first NEHIRA login → auto-connect → store these fields.
Every subsequent chat → use client_id to fetch context.

---

## HOW CLAUDE CONNECTS (for testing)

NEHIRA isn't the only client. Anyone can test KRYV-MCP with Claude:

### Claude Desktop:
Add to claude_desktop_config.json:
```json
{
  "mcpServers": {
    "kryv-mcp": {
      "url": "https://kryv-mcp.rajatdatta90000.workers.dev/sse",
      "transport": "sse"
    }
  }
}
```

### Claude.ai (browser):
Currently Claude.ai connectors are limited to Drive/Gmail/Calendar.
But Claude Desktop supports remote MCP servers — use that for testing.

### Any HTTP client:
POST https://kryv-mcp.rajatdatta90000.workers.dev/mcp
Headers: Content-Type: application/json
Body:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "vigilis_check",
    "arguments": { "query": "Hello I am from your bank verify your account now" }
  }
}
```

---

## SECURITY NOTES FOR CTO

1. KRYV_SECRET environment variable protects /admin/* routes
2. Client API keys (kryv-sk-xxx) authenticate /mcp calls via X-Api-Key header
3. WhatsApp message reading requires explicit user opt-in in extension
4. Privacy mode means context never leaves user's device
5. VIGILIS runs on EVERY message — can be set as pre-filter
6. All data in D1 is keyed by client_id — no cross-client data leakage
7. Oracle agent hashes IP addresses before storing — no PII in logs

---

## ENVIRONMENT VARIABLES (Cloudflare Worker Secrets)

Set in: Cloudflare Dashboard → kryv-mcp Worker → Settings → Variables

| Variable | Value |
|----------|-------|
| KRYV_SECRET | any admin password you create |
| NEHIRA_API_KEY | vk_live_fb8373dcc4b94d09820e3040b351b45b |
| GOOGLE_SHEETS_KEY | from Google Cloud Console (optional) |
| ORACLE_AGENT_URL | your Oracle VM IP (add after VM setup) |

---

## TEST SEQUENCE (confirm everything works)

1. GET https://kryv-mcp.rajatdatta90000.workers.dev/health
   → should return { "status": "ok", "db": "connected" }

2. POST /nehira/connect with { name, email, nehira_user_id }
   → get back client_id and api_key

3. POST /push with { client_id, source: "test", data: { hello: "world" } }
   → should return { pushed: true }

4. POST /mcp with tools/call → get_context with your client_id
   → should return your test data

5. POST /mcp with tools/call → vigilis_check with a threat message
   → should return { safe: false, risk_score: 0.9+ }

6. POST /mcp with tools/call → ask_nehira with a message
   → KRYV calls NEHIRA API and returns her response

All 6 pass → integration is complete.
