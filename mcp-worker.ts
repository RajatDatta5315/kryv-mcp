/**
 * KRYV-MCP Worker v0.7
 *
 * NEW IN v0.7:
 * - Claude API built-in: /claude endpoint — use Claude directly, no Cursor needed
 * - OAuth 2.0 server: /.well-known/oauth-authorization-server
 * - /oauth/authorize, /oauth/token — claude.ai custom connector support
 * - All previous GitHub OAuth + per-user tokens kept
 * - ask_claude tool in MCP tools list
 */

export interface Env {
  DB: D1Database;
  KRYV_SECRET: string;
  NEHIRA_API_KEY: string;
  ANTHROPIC_API_KEY: string;   // NEW: add in Cloudflare secrets
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GOOGLE_SHEETS_KEY: string;
}

const ORIGIN = "https://kryv-mcp.rajatdatta90000.workers.dev";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Client-Id, Mcp-Session-Id",
  "Cache-Control": "no-cache",
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const html = (h: string, s = 200) =>
  new Response(h, { status: s, headers: { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" } });

// ─── D1 ───
const run   = (db: D1Database, sql: string, p: unknown[] = []) => db.prepare(sql).bind(...p).run();
const all   = (db: D1Database, sql: string, p: unknown[] = []) => db.prepare(sql).bind(...p).all();
const first = (db: D1Database, sql: string, p: unknown[] = []) => db.prepare(sql).bind(...p).first();

async function logUsage(db: D1Database, tool: string, ms: number, status: string, clientId?: string) {
  try { await run(db, `INSERT INTO usage_logs(client_id,tool_name,vigilis_safe,response_ms,status,created_at)VALUES(?,?,1,?,?,datetime('now'))`, [clientId||null,tool,ms,status]); }
  catch { /* non-blocking */ }
}

async function cacheGet(db: D1Database, key: string) {
  const r = await first(db, `SELECT value FROM kv_cache WHERE key=? AND (expires_at IS NULL OR expires_at > datetime('now'))`, [key]);
  return r ? (r as {value:string}).value : null;
}
async function cacheSet(db: D1Database, key: string, value: string, ttl?: number) {
  const exp = ttl ? `datetime('now', '+${ttl} seconds')` : "NULL";
  await run(db, `INSERT INTO kv_cache(key,value,expires_at)VALUES(?,?,${exp}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`, [key, value]);
}
async function pushContext(db: D1Database, clientId: string, source: string, data: unknown) {
  await run(db, `INSERT INTO context_store(client_id,source,data,updated_at)VALUES(?,?,?,datetime('now')) ON CONFLICT(client_id,source) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`, [clientId, source, JSON.stringify(data)]);
}
async function getContext(db: D1Database, clientId: string, source?: string) {
  if (source) return first(db, `SELECT source,data,updated_at FROM context_store WHERE client_id=? AND source=?`, [clientId,source]);
  return all(db, `SELECT source,data,updated_at FROM context_store WHERE client_id=? ORDER BY updated_at DESC`, [clientId]);
}

// ─── VIGILIS ───
function vigilis(input: string) {
  const threats = [
    { re:/bank.*verif|account.*suspend|wire.*transfer|urgent.*payment/i, cat:"phishing",     p:"bank-impersonation", s:0.92 },
    { re:/ignore.*previous.*instruction|forget.*system.*prompt/i,        cat:"jailbreak",    p:"prompt-injection",   s:0.97 },
    { re:/you are now|act as.*without restriction/i,                      cat:"jailbreak",    p:"persona-override",   s:0.95 },
    { re:/\bDAN\b|jailbreak|no content policy/i,                          cat:"jailbreak",    p:"dan-attack",         s:0.96 },
    { re:/send.*bitcoin|crypto.*wallet.*payment/i,                        cat:"phishing",     p:"crypto-scam",        s:0.91 },
    { re:/dump.*table|show.*all.*passwords|export.*database/i,            cat:"exfiltration", p:"db-dump",            s:0.90 },
  ];
  let best = 0, matched: typeof threats[0]|null = null;
  for (const th of threats) {
    if (th.re.test(input) && th.s > best) { best = th.s; matched = th; }
  }
  if (matched) return { safe:false, risk_score:best, pattern:matched.p, category:matched.cat, recommendation:"BLOCK" };
  return { safe:true, risk_score:0.02, pattern:null, category:null, recommendation:"PROCEED" };
}

// ─── CLAUDE API ───
async function askClaude(apiKey: string, message: string, system?: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: system || "You are KRYV-MCP's built-in AI. Be concise and helpful.",
      messages: [{ role: "user", content: message }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const d = await res.json() as { content: Array<{type:string;text:string}> };
  return d.content.filter(b => b.type === "text").map(b => b.text).join("");
}

// ─── GITHUB PER-USER ───
async function getUserGH(db: D1Database, clientId: string) {
  const r = await first(db, `SELECT github_token, github_username FROM clients WHERE client_id=?`, [clientId]);
  if (!r || !(r as {github_token?:string}).github_token) return null;
  return { token: (r as {github_token:string}).github_token, owner: (r as {github_username:string}).github_username };
}
async function ghReq(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { "Authorization":`Bearer ${token}`, "Accept":"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28", "Content-Type":"application/json", "User-Agent":"KRYV-MCP/0.7" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(d as {message?:string}).message}`);
  return d;
}
async function ghGetFile(token: string, owner: string, repo: string, path: string, branch = "main") {
  try {
    const d = await ghReq(token, "GET", `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`) as {content:string;sha:string};
    return { content: atob(d.content.replace(/\n/g,"")), sha: d.sha };
  } catch { return null; }
}
async function ghDefaultBranch(token: string, owner: string, repo: string) {
  const d = await ghReq(token, "GET", `/repos/${owner}/${repo}`) as {default_branch:string};
  return d.default_branch || "main";
}
async function ghListFiles(token: string, owner: string, repo: string, path = "", branch?: string) {
  const b = branch || await ghDefaultBranch(token, owner, repo);
  const d = await ghReq(token, "GET", `/repos/${owner}/${repo}/contents/${path}?ref=${b}`) as Array<{name:string;type:string;path:string;size:number}>;
  return { path, repo, branch:b, files: Array.isArray(d) ? d.map(f=>({name:f.name,type:f.type,path:f.path,size:f.size})) : [] };
}
async function ghReadFile(token: string, owner: string, repo: string, path: string, branch?: string) {
  const b = branch || await ghDefaultBranch(token, owner, repo);
  const f = await ghGetFile(token, owner, repo, path, b);
  return f ? { found:true, path, repo, branch:b, content:f.content, sha:f.sha } : { found:false, path, repo };
}
async function ghWriteFile(token: string, owner: string, repo: string, path: string, content: string, message: string, branch?: string) {
  const b = branch || await ghDefaultBranch(token, owner, repo);
  const existing = await ghGetFile(token, owner, repo, path, b);
  const body: Record<string,unknown> = { message, content:btoa(unescape(encodeURIComponent(content))), branch:b };
  if (existing?.sha) body.sha = existing.sha;
  await ghReq(token, "PUT", `/repos/${owner}/${repo}/contents/${path}`, body);
  // Auto-changelog
  try {
    const prev = await ghGetFile(token, owner, repo, "CHANGELOG.md", b);
    const entry = `## ${new Date().toISOString().slice(0,19).replace("T"," ")} UTC\n\n${message}\n\n**File:** \`${path}\`\n\n---\n\n`;
    const newContent = prev ? `# Changelog\n\n${entry}${prev.content.replace(/^# Changelog\n\n/,"")}` : `# Changelog\n\n${entry}`;
    const clBody: Record<string,unknown> = { message:`chore: log — ${message.slice(0,60)}`, content:btoa(unescape(encodeURIComponent(newContent))), branch:b };
    const cl = await ghGetFile(token, owner, repo, "CHANGELOG.md", b);
    if (cl?.sha) clBody.sha = cl.sha;
    await ghReq(token, "PUT", `/repos/${owner}/${repo}/contents/CHANGELOG.md`, clBody);
  } catch { /* non-blocking */ }
  return { written:true, path, repo, branch:b, action:existing?"updated":"created" };
}
async function ghListRepos(token: string) {
  const d = await ghReq(token, "GET", `/user/repos?per_page=100&sort=updated&type=all`) as Array<{name:string;full_name:string;private:boolean;updated_at:string}>;
  return { repos:d.map(r=>({name:r.name,full_name:r.full_name,private:r.private,updated_at:r.updated_at})), count:d.length };
}
async function ghCreateBranch(token: string, owner: string, repo: string, newBranch: string, fromBranch?: string) {
  const base = fromBranch || await ghDefaultBranch(token, owner, repo);
  const ref = await ghReq(token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${base}`) as {object:{sha:string}};
  await ghReq(token, "POST", `/repos/${owner}/${repo}/git/refs`, { ref:`refs/heads/${newBranch}`, sha:ref.object.sha });
  return { created:true, branch:newBranch, from:base };
}
async function ghCreatePR(token: string, owner: string, repo: string, title: string, body: string, head: string, base?: string) {
  const b = base || await ghDefaultBranch(token, owner, repo);
  const d = await ghReq(token, "POST", `/repos/${owner}/${repo}/pulls`, { title, body, head, base:b }) as {html_url:string;number:number};
  return { created:true, pr_url:d.html_url, pr_number:d.number };
}

// ─── GITHUB OAUTH ───
async function handleGitHubOAuth(url: URL, env: Env): Promise<Response> {
  const kryvClientId = url.searchParams.get("client_id");
  if (!kryvClientId) return json({ error:"client_id required" }, 400);
  const state = kryvClientId + ":" + crypto.randomUUID().slice(0,8);
  const ghUrl = new URL("https://github.com/login/oauth/authorize");
  ghUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  ghUrl.searchParams.set("scope", "repo,workflow");
  ghUrl.searchParams.set("state", state);
  ghUrl.searchParams.set("redirect_uri", `${ORIGIN}/github/callback`);
  return Response.redirect(ghUrl.toString(), 302);
}
async function handleGitHubCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return html("<p>Error: missing code/state</p>", 400);
  const kryvClientId = state.split(":")[0];
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method:"POST", headers:{"Accept":"application/json","Content-Type":"application/json"},
    body:JSON.stringify({ client_id:env.GITHUB_CLIENT_ID, client_secret:env.GITHUB_CLIENT_SECRET, code }),
  });
  const tokenData = await tokenRes.json() as { access_token?:string; error?:string };
  if (!tokenData.access_token) return html(`<p>GitHub auth failed: ${tokenData.error}</p>`, 400);
  const userRes = await fetch("https://api.github.com/user", { headers:{"Authorization":`Bearer ${tokenData.access_token}`,"User-Agent":"KRYV-MCP/0.7"} });
  const user = await userRes.json() as { login:string };
  await run(env.DB, `UPDATE clients SET github_token=?,github_username=?,github_connected=1 WHERE client_id=?`, [tokenData.access_token, user.login, kryvClientId]);
  return html(`<!DOCTYPE html><html><head><title>Connected!</title>
    <link href="https://fonts.googleapis.com/css2?family=Syne:wght@900&family=DM+Mono&display=swap" rel="stylesheet"/>
    <style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#020408;color:#e2e8f0;font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .b{text-align:center;padding:48px;}.icon{font-size:56px;margin-bottom:20px;}h2{font-family:'Syne',sans-serif;font-size:26px;font-weight:900;color:#4ade80;margin-bottom:10px;}
    p{color:#64748b;font-size:14px;line-height:1.6;}a{color:#38bdf8;text-decoration:none;}code{font-family:'DM Mono',monospace;background:rgba(56,189,248,.1);color:#38bdf8;padding:2px 8px;border-radius:4px;}</style></head>
    <body><div class="b"><div class="icon">✓</div><h2>GitHub Connected!</h2>
    <p>Account: <code>@${user.login}</code></p><p style="margin-top:8px">KRYV-MCP can now access all your repos.</p>
    <p style="margin-top:20px"><a href="/connect">← Back to Connect</a></p></div></body></html>`);
}

// ─── OAUTH 2.0 SERVER (for claude.ai custom connector) ───
// Claude.ai reads /.well-known/oauth-authorization-server to discover endpoints
async function handleOAuthMeta(url: URL): Promise<Response> {
  return new Response(JSON.stringify({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    scopes_supported: ["read", "write"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://mcp.kryv.network",
  }), { headers: { "Content-Type":"application/json", ...CORS } });
}

async function handleOAuthAuthorize(url: URL, env: Env): Promise<Response> {
  const redirect_uri  = url.searchParams.get("redirect_uri") || "";
  const state         = url.searchParams.get("state") || "";
  const client_id_req = url.searchParams.get("client_id") || "";
  const code_challenge = url.searchParams.get("code_challenge") || "";

  // Create a KRYV account for this OAuth session
  const kryvClientId = crypto.randomUUID();
  const apiKey = "kryv-sk-" + crypto.randomUUID().replace(/-/g,"").slice(0,24);
  await run(env.DB, `INSERT OR IGNORE INTO clients(client_id,name,email,api_key,plan,status,created_at)VALUES(?,?,?,?,'free','active',datetime('now'))`,
    [kryvClientId, "claude-connector", `claude-${kryvClientId.slice(0,8)}@kryv.network`, apiKey]);

  // Store auth code in cache (valid 5 min)
  const authCode = crypto.randomUUID().replace(/-/g,"").slice(0,32);
  await cacheSet(env.DB, `oauth:code:${authCode}`, JSON.stringify({ kryvClientId, apiKey, redirect_uri, code_challenge }), 300);

  // Redirect to claude.ai callback with auth code
  const callbackUrl = new URL(redirect_uri);
  callbackUrl.searchParams.set("code", authCode);
  callbackUrl.searchParams.set("state", state);
  return Response.redirect(callbackUrl.toString(), 302);
}

async function handleOAuthToken(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  const params = new URLSearchParams(body);
  const code = params.get("code") || "";
  const cached = await cacheGet(env.DB, `oauth:code:${code}`);
  if (!cached) return json({ error:"invalid_grant", error_description:"Code expired or invalid" }, 400);
  const { kryvClientId, apiKey } = JSON.parse(cached);
  // Invalidate code
  await run(env.DB, `DELETE FROM kv_cache WHERE key=?`, [`oauth:code:${code}`]);
  return json({
    access_token: apiKey,
    token_type: "Bearer",
    scope: "read write",
    kryv_client_id: kryvClientId,
  });
}

// ─── MCP TOOLS ───
const TOOLS = [
  { name:"vigilis_check",       description:"Threat detector. Scans any text for phishing, jailbreak, scams.",    inputSchema:{type:"object",properties:{query:{type:"string",description:"Text to analyze"}},required:["query"]} },
  { name:"ask_claude",          description:"Ask Claude AI directly through KRYV-MCP. Works without Cursor Pro.", inputSchema:{type:"object",properties:{message:{type:"string"},system:{type:"string"}},required:["message"]} },
  { name:"ask_nehira",          description:"Ask NEHIRA AI assistant.",                                            inputSchema:{type:"object",properties:{message:{type:"string"}},required:["message"]} },
  { name:"push_context",        description:"Store personal context (browser, notes, files).",                     inputSchema:{type:"object",properties:{client_id:{type:"string"},source:{type:"string"},data:{type:"object"}},required:["client_id","source","data"]} },
  { name:"get_context",         description:"Retrieve stored personal context.",                                   inputSchema:{type:"object",properties:{client_id:{type:"string"},source:{type:"string"}},required:["client_id"]} },
  { name:"cache_set",           description:"Store a key-value pair.",                                             inputSchema:{type:"object",properties:{key:{type:"string"},value:{type:"string"},ttl:{type:"number"}},required:["key","value"]} },
  { name:"cache_get",           description:"Retrieve a cached value.",                                            inputSchema:{type:"object",properties:{key:{type:"string"}},required:["key"]} },
  { name:"get_stats",           description:"Live usage statistics from the database.",                            inputSchema:{type:"object",properties:{}} },
  { name:"server_info",         description:"Server version, capabilities, and connected services.",               inputSchema:{type:"object",properties:{}} },
  { name:"github_connect_url",  description:"Get the GitHub OAuth URL so user can connect their own GitHub.",     inputSchema:{type:"object",properties:{client_id:{type:"string"}},required:["client_id"]} },
  { name:"github_list_repos",   description:"List all repos on the user's own GitHub account.",                   inputSchema:{type:"object",properties:{}} },
  { name:"github_read_file",    description:"Read a file from the user's GitHub repo.",                           inputSchema:{type:"object",properties:{repo:{type:"string"},path:{type:"string"},branch:{type:"string"}},required:["repo","path"]} },
  { name:"github_list_files",   description:"List files in a directory of the user's GitHub repo.",              inputSchema:{type:"object",properties:{repo:{type:"string"},path:{type:"string"},branch:{type:"string"}},required:["repo"]} },
  { name:"github_write_file",   description:"Write a file to the user's GitHub repo. Auto-logs to CHANGELOG.",   inputSchema:{type:"object",properties:{repo:{type:"string"},path:{type:"string"},content:{type:"string"},message:{type:"string"},branch:{type:"string"}},required:["repo","path","content","message"]} },
  { name:"github_create_branch",description:"Create a branch in the user's GitHub repo.",                        inputSchema:{type:"object",properties:{repo:{type:"string"},new_branch:{type:"string"},from_branch:{type:"string"}},required:["repo","new_branch"]} },
  { name:"github_create_pr",    description:"Create a pull request in the user's GitHub repo.",                  inputSchema:{type:"object",properties:{repo:{type:"string"},title:{type:"string"},body:{type:"string"},head:{type:"string"},base:{type:"string"}},required:["repo","title","body","head"]} },
];

// ─── TOOL EXECUTOR ───
async function executeTool(name: string, args: Record<string,unknown>, env: Env, clientId?: string) {
  const t0 = Date.now();
  const wrap = (d: unknown) => ({ content:[{ type:"text", text:JSON.stringify(d,null,2) }] });
  try {
    const userGH = clientId ? await getUserGH(env.DB, clientId) : null;
    let result: unknown;
    switch (name) {
      case "vigilis_check": {
        const r = vigilis(String(args.query||""));
        if (!r.safe) await run(env.DB,`INSERT INTO vigilis_incidents(client_id,risk_score,pattern,category,action_taken,created_at)VALUES(?,?,?,?,'blocked',datetime('now'))`,[clientId||null,r.risk_score,r.pattern,r.category]);
        result = r; break;
      }
      case "ask_claude": {
        if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set in Cloudflare secrets");
        const reply = await askClaude(env.ANTHROPIC_API_KEY, String(args.message||""), args.system?String(args.system):undefined);
        result = { reply, model:"claude-haiku-4-5" }; break;
      }
      case "ask_nehira": {
        const res = await fetch("https://vokryl.kryv.network/api/nehira/chat",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${env.NEHIRA_API_KEY}`},body:JSON.stringify({message:String(args.message)})});
        if (!res.ok) throw new Error(`NEHIRA ${res.status}`);
        const d = await res.json() as {response?:string;message?:string;reply?:string};
        result = { answer:d.response||d.message||d.reply||"No response", model:"NEHIRA" }; break;
      }
      case "push_context": await pushContext(env.DB,String(args.client_id),String(args.source),args.data); result={stored:true}; break;
      case "get_context":  result=await getContext(env.DB,String(args.client_id),args.source?String(args.source):undefined); break;
      case "cache_set":    await cacheSet(env.DB,String(args.key),String(args.value),args.ttl?Number(args.ttl):undefined); result={stored:true}; break;
      case "cache_get": {  const v=await cacheGet(env.DB,String(args.key)); result={key:args.key,value:v,found:v!==null}; break; }
      case "get_stats": {
        const [tot,blk,cli,top]=await Promise.all([first(env.DB,`SELECT COUNT(*)as n FROM usage_logs`),first(env.DB,`SELECT COUNT(*)as n FROM vigilis_incidents`),first(env.DB,`SELECT COUNT(*)as n FROM clients WHERE status='active'`),all(env.DB,`SELECT tool_name,COUNT(*)as uses FROM usage_logs GROUP BY tool_name ORDER BY uses DESC LIMIT 8`)]);
        result={total_requests:(tot as {n:number})?.n||0,vigilis_blocks:(blk as {n:number})?.n||0,active_clients:(cli as {n:number})?.n||0,top_tools:top.results}; break;
      }
      case "server_info": result={name:"KRYV-MCP",version:"0.7.0",claude_built_in:true,github_oauth:true,per_user_tokens:true,tools:TOOLS.map(t=>t.name),mcp_version:"2024-11-05"}; break;
      case "github_connect_url":
        result={connect_url:`${ORIGIN}/github/oauth?client_id=${args.client_id}`,instruction:"Open this URL in browser to connect GitHub"}; break;
      case "github_list_repos":
        if (!userGH) throw new Error("GitHub not connected. Call github_connect_url first.");
        result = await ghListRepos(userGH.token); break;
      case "github_read_file":
        if (!userGH) throw new Error("GitHub not connected.");
        result = await ghReadFile(userGH.token, userGH.owner, String(args.repo), String(args.path), args.branch?String(args.branch):undefined); break;
      case "github_list_files":
        if (!userGH) throw new Error("GitHub not connected.");
        result = await ghListFiles(userGH.token, userGH.owner, String(args.repo), String(args.path||""), args.branch?String(args.branch):undefined); break;
      case "github_write_file":
        if (!userGH) throw new Error("GitHub not connected.");
        result = await ghWriteFile(userGH.token, userGH.owner, String(args.repo), String(args.path), String(args.content), String(args.message), args.branch?String(args.branch):undefined); break;
      case "github_create_branch":
        if (!userGH) throw new Error("GitHub not connected.");
        result = await ghCreateBranch(userGH.token, userGH.owner, String(args.repo), String(args.new_branch), args.from_branch?String(args.from_branch):undefined); break;
      case "github_create_pr":
        if (!userGH) throw new Error("GitHub not connected.");
        result = await ghCreatePR(userGH.token, userGH.owner, String(args.repo), String(args.title), String(args.body), String(args.head), args.base?String(args.base):undefined); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    await logUsage(env.DB, name, Date.now()-t0, "success", clientId);
    return wrap(result);
  } catch(e) {
    await logUsage(env.DB, name, Date.now()-t0, "error", clientId);
    return wrap({ error:String(e), tool:name });
  }
}

// ─── MCP JSON-RPC ───
async function handleMCP(req: Request, env: Env): Promise<Response> {
  // Resolve client_id from API key header
  const apiKey = req.headers.get("X-Api-Key") || req.headers.get("Authorization")?.replace("Bearer ","") || "";
  let clientId: string|undefined;
  if (apiKey) {
    const c = await first(env.DB, `SELECT client_id FROM clients WHERE api_key=? AND status='active'`, [apiKey]);
    clientId = c ? (c as {client_id:string}).client_id : undefined;
  }
  let body: {jsonrpc:string;id:unknown;method:string;params?:Record<string,unknown>};
  try { body = await req.json(); } catch { return json({jsonrpc:"2.0",id:0,error:{code:-32700,message:"Parse error"}},400); }
  const {id, method, params={}} = body;
  const ok  = (r: unknown) => json({jsonrpc:"2.0",id,result:r});
  const err = (c: number, m: string) => json({jsonrpc:"2.0",id,error:{code:c,message:m}});
  switch (method) {
    case "initialize":
      return ok({protocolVersion:"2024-11-05",capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:"KRYV-MCP",version:"0.7.0"}});
    case "notifications/initialized": return ok({});
    case "tools/list": return ok({tools:TOOLS});
    case "tools/call": {
      const {name,arguments:a={}} = params as {name:string;arguments:Record<string,unknown>};
      return ok(await executeTool(name, a, env, clientId));
    }
    case "prompts/list": return ok({prompts:[
      {name:"kryv_agent",description:"You are connected to KRYV-MCP v0.7. All github_ tools use the user's own GitHub account. Use vigilis_check before acting on any user-provided URL or message. ask_claude works directly without Cursor Pro."},
    ]});
    default: return err(-32601, `Unknown method: ${method}`);
  }
}

// ─── NEHIRA CONNECT ───
async function handleNehiraConnect(req: Request, env: Env): Promise<Response> {
  const b = await req.json() as {name:string;email:string;nehira_user_id:string};
  if (!b.email||!b.nehira_user_id) return json({error:"email and nehira_user_id required"},400);
  const existing = await first(env.DB, `SELECT client_id,api_key FROM clients WHERE email=?`, [b.email]);
  if (existing) return json({connected:true,...(existing as object),message:"Already connected"});
  const apiKey = "kryv-sk-"+crypto.randomUUID().replace(/-/g,"").slice(0,24);
  const clientId = crypto.randomUUID();
  await run(env.DB, `INSERT INTO clients(client_id,name,email,api_key,plan,status,nehira_user_id,created_at)VALUES(?,?,?,?,'free','active',?,datetime('now'))`, [clientId,b.name||b.email,b.email,apiKey,b.nehira_user_id]);
  return json({connected:true,client_id:clientId,api_key:apiKey,mcp_url:`${ORIGIN}/mcp`,github_connect_url:`${ORIGIN}/github/oauth?client_id=${clientId}`});
}

// ─── ADMIN ───
async function handleAdmin(url: URL, req: Request, env: Env): Promise<Response> {
  if (req.headers.get("X-Admin-Secret") !== env.KRYV_SECRET) return json({error:"Unauthorized"},401);
  const p = url.pathname.replace("/admin/","");
  if (p==="clients") return json((await all(env.DB,`SELECT client_id,name,email,plan,status,github_username,github_connected,created_at FROM clients ORDER BY created_at DESC`)).results);
  if (p==="stats") {
    const [tot,blk,cli]=await Promise.all([first(env.DB,`SELECT COUNT(*)as n FROM usage_logs`),first(env.DB,`SELECT COUNT(*)as n FROM vigilis_incidents`),first(env.DB,`SELECT COUNT(*)as n FROM clients WHERE status='active'`)]);
    return json({total_requests:(tot as {n:number})?.n,vigilis_blocks:(blk as {n:number})?.n,active_clients:(cli as {n:number})?.n});
  }
  if (p==="logs") return json((await all(env.DB,`SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT 100`)).results);
  return json({error:"Not found"},404);
}

// ─── MAIN ───
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {status:204, headers:CORS});

    // Health
    if (url.pathname === "/health") {
      const dbOk = await first(env.DB,`SELECT 1 as ok`).then(()=>true).catch(()=>false);
      return json({status:"ok",db:dbOk?"connected":"error",server:"KRYV-MCP",version:"0.7.0",claude_builtin:!!env.ANTHROPIC_API_KEY,ts:new Date().toISOString()});
    }

    // MCP endpoint
    if (url.pathname === "/mcp" && req.method === "POST") return handleMCP(req, env);
    if (url.pathname === "/mcp" && req.method === "GET")
      return json({name:"KRYV-MCP",version:"0.7.0",transport:"http+sse",sse:`${ORIGIN}/sse`,mcp:`${ORIGIN}/mcp`});

    // SSE — proper endpoint event for Cursor/Windsurf/Claude Desktop
    if (url.pathname === "/sse" && req.method === "GET") {
      const sessionId = crypto.randomUUID();
      const mcpEndpoint = `${ORIGIN}/mcp`;
      const stream = new ReadableStream({start(ctrl) {
        const enc = new TextEncoder();
        // CRITICAL: send endpoint event first — this is what Cursor reads
        ctrl.enqueue(enc.encode(`event: endpoint\ndata: ${mcpEndpoint}\n\n`));
        const t = setInterval(() => ctrl.enqueue(enc.encode(`: ping\n\n`)), 15000);
        req.signal.addEventListener("abort", () => { clearInterval(t); try{ctrl.close();}catch{/***/} });
      }});
      return new Response(stream, { headers:{...CORS,"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive","X-Accel-Buffering":"no"} });
    }
    // Some old clients POST to /sse
    if (url.pathname === "/sse" && req.method === "POST") return handleMCP(req, env);

    // Push context
    if (url.pathname === "/push" && req.method === "POST") {
      const b = await req.json() as {client_id:string;source:string;data:unknown};
      if (!b.client_id||!b.source) return json({error:"client_id and source required"},400);
      await pushContext(env.DB, b.client_id, b.source, b.data);
      return json({pushed:true, source:b.source});
    }

    // GitHub OAuth
    if (url.pathname === "/github/oauth"    && req.method === "GET") return handleGitHubOAuth(url, env);
    if (url.pathname === "/github/callback" && req.method === "GET") return handleGitHubCallback(url, env);

    // KRYV OAuth 2.0 server (for claude.ai custom connector)
    if (url.pathname === "/.well-known/oauth-authorization-server") return handleOAuthMeta(url);
    if (url.pathname === "/oauth/authorize" && req.method === "GET")  return handleOAuthAuthorize(url, env);
    if (url.pathname === "/oauth/token"     && req.method === "POST") return handleOAuthToken(req, env);

    // Claude API proxy (direct use without Cursor)
    if (url.pathname === "/claude" && req.method === "POST") {
      try {
        const b = await req.json() as {message:string;system?:string;api_key?:string};
        const key = b.api_key || env.ANTHROPIC_API_KEY;
        if (!key) return json({error:"No API key. Set ANTHROPIC_API_KEY in Cloudflare secrets or pass api_key in body."},400);
        const reply = await askClaude(key, b.message, b.system);
        return json({reply, model:"claude-haiku-4-5"});
      } catch(e) { return json({error:String(e)},500); }
    }

    // NEHIRA connect
    if (url.pathname === "/nehira/connect" && req.method === "POST") return handleNehiraConnect(req, env);

    // Admin
    if (url.pathname.startsWith("/admin/")) return handleAdmin(url, req, env);

    // Root
    if (url.pathname === "/")
      return json({name:"KRYV-MCP",version:"0.7.0",endpoints:{health:"/health",mcp:"/mcp",sse:"/sse",push:"/push",claude:"/claude",github_oauth:"/github/oauth?client_id=YOUR_ID",oauth_meta:"/.well-known/oauth-authorization-server"},docs:"mcp.kryv.network"});

    return json({error:"Not found"},404);
  },
};
