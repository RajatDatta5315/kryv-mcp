/**
 * KRYV-MCP Worker v0.3 — mcp-worker.ts
 * Cloudflare Workers + D1 only (no KV)
 * NEHIRA integrated via vokryl.kryv.network
 * WhatsApp full message context enabled
 */

export interface Env {
  DB: D1Database;
  KRYV_SECRET: string;
  NEHIRA_API_KEY: string;       // vk_live_fb8373dcc4b94d09820e3040b351b45b
  GOOGLE_SHEETS_KEY: string;
  ORACLE_AGENT_URL: string;     // add after Oracle VM setup
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Client-Id",
  "Cache-Control": "no-cache",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });

// ─────────────────────────────────────────
// D1 HELPERS (no KV — everything in D1)
// ─────────────────────────────────────────
const run  = (db: D1Database, sql: string, p: unknown[] = []) => db.prepare(sql).bind(...p).run();
const all  = (db: D1Database, sql: string, p: unknown[] = []) => db.prepare(sql).bind(...p).all();
const first= (db: D1Database, sql: string, p: unknown[] = []) => db.prepare(sql).bind(...p).first();

// ─────────────────────────────────────────
// VIGILIS — False Conversation Detector
// ─────────────────────────────────────────
function vigilis(input: string) {
  const t = input.toLowerCase();
  const threats = [
    { re: /bank.*verif|account.*suspend|wire.*transfer|urgent.*payment/i,    cat:"phishing",      p:"bank-impersonation",  s:0.92 },
    { re: /click.*link.*verify|reset.*password.*immediately/i,               cat:"phishing",      p:"credential-theft",    s:0.88 },
    { re: /send.*bitcoin|crypto.*wallet.*payment/i,                           cat:"phishing",      p:"crypto-scam",         s:0.91 },
    { re: /ignore.*previous.*instruction|forget.*system.*prompt/i,           cat:"jailbreak",     p:"prompt-injection",    s:0.97 },
    { re: /you are now|act as.*without restriction|pretend you/i,            cat:"jailbreak",     p:"persona-override",    s:0.95 },
    { re: /\bDAN\b|jailbreak|no content policy/i,                            cat:"jailbreak",     p:"dan-attack",          s:0.96 },
    { re: /prince.*nigeria|lottery.*winner/i,                                 cat:"scam",          p:"advance-fee",         s:0.93 },
    { re: /dump.*table|show.*all.*passwords|export.*database/i,              cat:"exfiltration",  p:"db-dump",             s:0.90 },
  ];
  const flagged: string[] = [];
  let best = 0, matched: typeof threats[0] | null = null;
  for (const th of threats) {
    if (th.re.test(t)) {
      const m = t.match(th.re);
      if (m) flagged.push(m[0].trim());
      if (th.s > best) { best = th.s; matched = th; }
    }
  }
  if (matched) return { safe:false, risk_score:best, pattern:matched.p, category:matched.cat, recommendation:`BLOCK — ${matched.cat}/${matched.p}`, flagged };
  return { safe:true, risk_score:0.02, pattern:null, category:null, recommendation:"PROCEED — clean", flagged:[] };
}

// ─────────────────────────────────────────
// CONTEXT STORE (D1)
// ─────────────────────────────────────────
async function pushContext(db: D1Database, clientId: string, source: string, data: unknown) {
  await run(db,
    `INSERT INTO context_store (client_id, source, data, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(client_id, source) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
    [clientId, source, JSON.stringify(data)]
  );
}

async function getContext(db: D1Database, clientId: string, source?: string) {
  if (source) return first(db, `SELECT source, data, updated_at FROM context_store WHERE client_id=? AND source=?`, [clientId, source]);
  return all(db, `SELECT source, data, updated_at FROM context_store WHERE client_id=? ORDER BY updated_at DESC`, [clientId]);
}

// Cache get/set using D1 (replaces KV)
async function cacheGet(db: D1Database, key: string): Promise<string | null> {
  const row = await first(db, `SELECT value FROM kv_cache WHERE key=? AND (expires_at IS NULL OR expires_at > datetime('now'))`, [key]);
  return row ? (row as { value: string }).value : null;
}

async function cacheSet(db: D1Database, key: string, value: string, ttlSeconds?: number) {
  const expires = ttlSeconds ? `datetime('now', '+${ttlSeconds} seconds')` : 'NULL';
  await run(db,
    `INSERT INTO kv_cache (key, value, expires_at) VALUES (?, ?, ${expires})
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`,
    [key, value]
  );
}

// Log usage
async function logUsage(db: D1Database, tool: string, safe: boolean, ms: number, status: string, clientId?: string) {
  try {
    await run(db,
      `INSERT INTO usage_logs (client_id, tool_name, vigilis_safe, response_ms, status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [clientId || null, tool, safe ? 1 : 0, ms, status]
    );
  } catch { /* non-blocking */ }
}

// ─────────────────────────────────────────
// NEHIRA API BRIDGE
// Forward queries to NEHIRA and return answer
// ─────────────────────────────────────────
async function askNehira(message: string, apiKey: string, context?: string): Promise<string> {
  const body: Record<string, unknown> = { message };
  if (context) body.system_context = context;

  const res = await fetch("https://vokryl.kryv.network/api/nehira/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`NEHIRA API error: ${res.status}`);
  const data = await res.json() as { response?: string; message?: string; reply?: string };
  return data.response || data.message || data.reply || "No response from NEHIRA";
}

// ─────────────────────────────────────────
// GOOGLE SHEETS BRIDGE
// ─────────────────────────────────────────
async function fetchSheet(sheetId: string, range: string, apiKey: string) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API ${res.status}`);
  const data = await res.json() as { values?: string[][] };
  const raw = data.values || [];
  if (!raw.length) return { headers: [], rows: [], count: 0 };
  const headers = raw[0];
  const rows = raw.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ""])));
  return { headers, rows, count: rows.length, fetched_at: new Date().toISOString() };
}

// ─────────────────────────────────────────
// MCP TOOLS
// ─────────────────────────────────────────
const TOOLS = [
  {
    name: "vigilis_check",
    description: "VIGILIS False Conversation & Threat Detector. Scans input for phishing, jailbreak, social engineering. Call first before any sensitive operation.",
    inputSchema: { type:"object", properties:{ query:{type:"string",description:"Text to scan"} }, required:["query"] },
  },
  {
    name: "ask_nehira",
    description: "Ask NEHIRA (KRYV's AI) a question. Optionally inject personal context. Returns NEHIRA's answer.",
    inputSchema: { type:"object", properties:{ message:{type:"string"}, context:{type:"string",description:"Optional context to inject"} }, required:["message"] },
  },
  {
    name: "push_context",
    description: "Store user context (browser tabs, WhatsApp, notes, files). Called by Chrome Extension and Oracle agent automatically.",
    inputSchema: { type:"object", properties:{ client_id:{type:"string"}, source:{type:"string",description:"browser_tabs|whatsapp_messages|notes|files|chrome_history"}, data:{type:"object"} }, required:["client_id","source","data"] },
  },
  {
    name: "get_context",
    description: "Get stored context for a user. Returns all their browser, WhatsApp, notes, file context.",
    inputSchema: { type:"object", properties:{ client_id:{type:"string"}, source:{type:"string",description:"optional — filter by source"} }, required:["client_id"] },
  },
  {
    name: "cache_set",
    description: "Store a key-value pair in D1 cache (replaces KV).",
    inputSchema: { type:"object", properties:{ key:{type:"string"}, value:{type:"string"}, ttl:{type:"number",description:"seconds"} }, required:["key","value"] },
  },
  {
    name: "cache_get",
    description: "Get a cached value by key from D1.",
    inputSchema: { type:"object", properties:{ key:{type:"string"} }, required:["key"] },
  },
  {
    name: "fetch_sheet",
    description: "Fetch live data from a Google Sheet. Grounds AI in real data.",
    inputSchema: { type:"object", properties:{ sheet_id:{type:"string"}, range:{type:"string"} }, required:["sheet_id"] },
  },
  {
    name: "get_stats",
    description: "Real usage stats: requests, clients, VIGILIS blocks, top tools.",
    inputSchema: { type:"object", properties:{} },
  },
  {
    name: "register_client",
    description: "Register a new client and get an API key. Used by NEHIRA auto-connect flow.",
    inputSchema: { type:"object", properties:{ name:{type:"string"}, email:{type:"string"}, plan:{type:"string",description:"free|pro|enterprise"} }, required:["name","email"] },
  },
  {
    name: "server_info",
    description: "KRYV-MCP server version, endpoints, and capabilities.",
    inputSchema: { type:"object", properties:{} },
  },
];

// ─────────────────────────────────────────
// TOOL EXECUTOR
// ─────────────────────────────────────────
async function executeTool(name: string, args: Record<string,unknown>, env: Env, clientId?: string) {
  const t0 = Date.now();
  const wrap = (d: unknown) => ({ content: [{ type:"text", text: JSON.stringify(d, null, 2) }] });

  try {
    let result: unknown;

    switch (name) {

      case "vigilis_check": {
        const r = vigilis(String(args.query || ""));
        if (!r.safe) {
          await run(env.DB,
            `INSERT INTO vigilis_incidents (client_id,risk_score,pattern,category,action_taken,created_at) VALUES (?,?,?,?,'blocked',datetime('now'))`,
            [clientId||null, r.risk_score, r.pattern, r.category]
          );
        }
        result = r; break;
      }

      case "ask_nehira": {
        const answer = await askNehira(String(args.message), env.NEHIRA_API_KEY, args.context ? String(args.context) : undefined);
        result = { answer, model: "NEHIRA", endpoint: "vokryl.kryv.network" }; break;
      }

      case "push_context": {
        await pushContext(env.DB, String(args.client_id), String(args.source), args.data);
        result = { stored:true, source:args.source, ts:new Date().toISOString() }; break;
      }

      case "get_context": {
        const ctx = await getContext(env.DB, String(args.client_id), args.source ? String(args.source) : undefined);
        result = ctx; break;
      }

      case "cache_set": {
        await cacheSet(env.DB, String(args.key), String(args.value), args.ttl ? Number(args.ttl) : undefined);
        result = { stored:true, key:args.key }; break;
      }

      case "cache_get": {
        const val = await cacheGet(env.DB, String(args.key));
        result = { key:args.key, value:val, found:val !== null }; break;
      }

      case "fetch_sheet": {
        result = await fetchSheet(String(args.sheet_id), String(args.range||"Sheet1!A1:Z100"), env.GOOGLE_SHEETS_KEY); break;
      }

      case "get_stats": {
        const [total, blocked, clients, tools] = await Promise.all([
          first(env.DB, `SELECT COUNT(*) as n FROM usage_logs`),
          first(env.DB, `SELECT COUNT(*) as n FROM vigilis_incidents`),
          first(env.DB, `SELECT COUNT(*) as n FROM clients WHERE status='active'`),
          all(env.DB,   `SELECT tool_name, COUNT(*) as uses FROM usage_logs GROUP BY tool_name ORDER BY uses DESC LIMIT 5`),
        ]);
        result = {
          total_requests: (total as {n:number})?.n || 0,
          vigilis_blocks: (blocked as {n:number})?.n || 0,
          active_clients: (clients as {n:number})?.n || 0,
          top_tools: tools.results,
        }; break;
      }

      case "register_client": {
        const apiKey = "kryv-sk-" + crypto.randomUUID().replace(/-/g,"").slice(0,24);
        const clientUUID = crypto.randomUUID();
        await run(env.DB,
          `INSERT INTO clients (client_id,name,email,api_key,plan,status,created_at) VALUES (?,?,?,?,?,  'active',datetime('now'))`,
          [clientUUID, String(args.name), String(args.email), apiKey, String(args.plan||"free")]
        );
        result = { created:true, client_id:clientUUID, api_key:apiKey, name:args.name, plan:args.plan||"free" }; break;
      }

      case "server_info": {
        result = { name:"KRYV-MCP", version:"0.3.0", domain:"mcp.kryv.network", db:"Cloudflare D1", nehira:"vokryl.kryv.network", tools:TOOLS.map(t=>t.name) }; break;
      }

      default: throw new Error(`Unknown tool: ${name}`);
    }

    await logUsage(env.DB, name, true, Date.now()-t0, "success", clientId);
    return wrap(result);
  } catch(e) {
    await logUsage(env.DB, name, true, Date.now()-t0, "error", clientId);
    return wrap({ error: String(e), tool: name });
  }
}

// ─────────────────────────────────────────
// NEHIRA AUTO-CONNECT FLOW
// One-click connect — no manual URL pasting
// NEHIRA calls POST /nehira/connect with user info
// Returns client_id + api_key for that user
// ─────────────────────────────────────────
async function handleNehiraConnect(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { name: string; email: string; nehira_user_id: string };
  if (!body.email || !body.nehira_user_id) return json({ error: "email and nehira_user_id required" }, 400);

  // Check if already registered
  const existing = await first(env.DB, `SELECT client_id, api_key FROM clients WHERE email=?`, [body.email]);
  if (existing) return json({ connected:true, ...(existing as object), message:"Already connected" });

  // Register new client
  const apiKey = "kryv-sk-" + crypto.randomUUID().replace(/-/g,"").slice(0,24);
  const clientId = crypto.randomUUID();
  await run(env.DB,
    `INSERT INTO clients (client_id,name,email,api_key,plan,status,nehira_user_id,created_at) VALUES (?,?,?,?,'free','active',?,datetime('now'))`,
    [clientId, body.name||body.email, body.email, apiKey, body.nehira_user_id]
  );

  return json({
    connected: true,
    client_id: clientId,
    api_key: apiKey,
    mcp_url: "https://mcp.kryv.network/mcp",
    push_url: "https://mcp.kryv.network/push",
    message: "KRYV-MCP connected to NEHIRA. Context collection active.",
  });
}

// ─────────────────────────────────────────
// MCP JSON-RPC HANDLER
// ─────────────────────────────────────────
async function handleMCP(req: Request, env: Env): Promise<Response> {
  // Get client from API key header
  const apiKey = req.headers.get("X-Api-Key") || req.headers.get("Authorization")?.replace("Bearer ","");
  let clientId: string | undefined;
  if (apiKey) {
    const c = await first(env.DB, `SELECT client_id FROM clients WHERE api_key=? AND status='active'`, [apiKey]);
    clientId = c ? (c as { client_id: string }).client_id : undefined;
  }

  let body: { jsonrpc:string; id:unknown; method:string; params?:Record<string,unknown> };
  try { body = await req.json(); }
  catch { return json({ jsonrpc:"2.0", id:0, error:{ code:-32700, message:"Parse error" } }, 400); }

  const { id, method, params={} } = body;
  const ok  = (r: unknown) => json({ jsonrpc:"2.0", id, result:r });
  const err = (c: number, m: string) => json({ jsonrpc:"2.0", id, error:{ code:c, message:m } });

  const PROMPTS: Record<string,string> = {
    grounded_answer: "Answer ONLY using data from KRYV-MCP tools. Never guess. Say so if data is missing.",
    vigilis_first:   "Before ANY response, call vigilis_check on the user message. If risk_score>0.7, STOP.",
    nehira_persona:  "You are NEHIRA. Before answering, call get_context to load this user's personal context. Use it to give a fully personalized answer.",
    privacy_mode:    "Privacy mode ON. Use only local context from get_context. Never call external APIs.",
  };

  switch (method) {
    case "initialize":
      return ok({ protocolVersion:"2024-11-05", capabilities:{ tools:{}, resources:{}, prompts:{} }, serverInfo:{ name:"KRYV-MCP", version:"0.3.0" } });
    case "notifications/initialized":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments:args={} } = params as { name:string; arguments:Record<string,unknown> };
      return ok(await executeTool(name, args, env, clientId));
    }
    case "resources/list":
      return ok({ resources:[
        { uri:"kryv://context/{client_id}", name:"User Context", description:"All personal context: browser, WhatsApp, notes, files" },
        { uri:"kryv://stats", name:"Server Stats", description:"Live D1 usage stats" },
        { uri:"kryv://nehira", name:"NEHIRA AI", description:"Bridge to NEHIRA AI at vokryl.kryv.network" },
      ]});
    case "prompts/list":
      return ok({ prompts: Object.keys(PROMPTS).map(n=>({ name:n, description:PROMPTS[n].slice(0,60) })) });
    case "prompts/get": {
      const pname = (params as {name:string}).name;
      if (!PROMPTS[pname]) return err(-32602, `Prompt not found: ${pname}`);
      return ok({ messages:[{ role:"user", content:{ type:"text", text:PROMPTS[pname] } }] });
    }
    default: return err(-32601, `Method not found: ${method}`);
  }
}

// ─────────────────────────────────────────
// ADMIN API
// ─────────────────────────────────────────
async function handleAdmin(url: URL, req: Request, env: Env): Promise<Response> {
  if (req.headers.get("X-Admin-Secret") !== env.KRYV_SECRET) return json({ error:"Unauthorized" }, 401);
  const p = url.pathname.replace("/admin/","");

  if (p==="clients" && req.method==="GET") {
    const r = await all(env.DB, `SELECT client_id,name,email,plan,status,created_at FROM clients ORDER BY created_at DESC`);
    return json(r.results);
  }
  if (p==="stats" && req.method==="GET") {
    const [total,blocks,clients,tools] = await Promise.all([
      first(env.DB, `SELECT COUNT(*) as n FROM usage_logs`),
      first(env.DB, `SELECT COUNT(*) as n FROM vigilis_incidents`),
      first(env.DB, `SELECT COUNT(*) as n FROM clients WHERE status='active'`),
      all(env.DB,   `SELECT tool_name,COUNT(*) as uses FROM usage_logs GROUP BY tool_name ORDER BY uses DESC`),
    ]);
    return json({ total_requests:(total as {n:number})?.n, vigilis_blocks:(blocks as {n:number})?.n, active_clients:(clients as {n:number})?.n, top_tools:tools.results });
  }
  if (p==="logs" && req.method==="GET") {
    const r = await all(env.DB, `SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT 100`);
    return json(r.results);
  }
  if (p==="context" && req.method==="GET") {
    const clientId = url.searchParams.get("client_id");
    if (!clientId) return json({ error:"client_id required" }, 400);
    const r = await all(env.DB, `SELECT source,data,updated_at FROM context_store WHERE client_id=? ORDER BY updated_at DESC`, [clientId]);
    return json(r.results);
  }
  return json({ error:"Not found" }, 404);
}

// ─────────────────────────────────────────
// MAIN FETCH
// ─────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method==="OPTIONS") return new Response(null, { status:204, headers:CORS });

    // Health
    if (url.pathname==="/health") {
      const dbOk = await first(env.DB, `SELECT 1 as ok`).then(()=>true).catch(()=>false);
      return json({ status:"ok", db:dbOk?"connected":"error", server:"KRYV-MCP", version:"0.3.0", ts:new Date().toISOString() });
    }

    // MCP
    if (url.pathname==="/mcp" && req.method==="POST") return handleMCP(req, env);

    // SSE stream
    if (url.pathname==="/sse" && req.method==="GET") {
      const origin = url.origin;
      const stream = new ReadableStream({ start(ctrl) {
        const enc = new TextEncoder();
        const send = (e:string,d:unknown) => ctrl.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
        send("endpoint", { uri:`${origin}/mcp`, transport:"http-post" });
        send("server", { name:"KRYV-MCP", version:"0.3.0" });
        const t = setInterval(()=>send("ping",{ts:Date.now()}), 20000);
        req.signal.addEventListener("abort", ()=>{ clearInterval(t); ctrl.close(); });
      }});
      return new Response(stream, { headers:{...CORS,"Content-Type":"text/event-stream","Connection":"keep-alive"} });
    }

    // Context push (from Chrome Extension / Oracle agent)
    if (url.pathname==="/push" && req.method==="POST") {
      const b = await req.json() as { client_id:string; source:string; data:unknown };
      if (!b.client_id||!b.source) return json({ error:"client_id and source required" }, 400);
      await pushContext(env.DB, b.client_id, b.source, b.data);
      return json({ pushed:true, source:b.source, ts:new Date().toISOString() });
    }

    // NEHIRA auto-connect (one-click, no manual URL paste)
    if (url.pathname==="/nehira/connect" && req.method==="POST") return handleNehiraConnect(req, env);

    // Admin
    if (url.pathname.startsWith("/admin/")) return handleAdmin(url, req, env);

    // Root
    if (url.pathname==="/") return json({
      name:"KRYV-MCP", version:"0.3.0", domain:"mcp.kryv.network",
      endpoints:{ health:"GET /health", mcp:"POST /mcp", sse:"GET /sse", push:"POST /push", nehira_connect:"POST /nehira/connect", admin:"* /admin/*" },
      claude_connect: { sse_url:"https://mcp.kryv.network/sse" },
      nehira_connect: { url:"https://mcp.kryv.network/nehira/connect", method:"POST", body:{ name:"User", email:"user@email.com", nehira_user_id:"uid" } },
    });

    return json({ error:"Not found" }, 404);
  },
};
