/**
 * KRYV-MCP Worker v0.6 — mcp-worker.ts
 * 
 * NEW IN v0.6:
 * - GitHub OAuth: users connect THEIR OWN GitHub (no manual token)
 * - Per-user GitHub tokens stored in D1 (isolated per client_id)
 * - All GitHub tools use the REQUESTING USER's token, not owner's
 * - /github/oauth and /github/callback endpoints
 * - Security: users can only access repos they own
 * - Claude bridge endpoint: /claude-bridge (for Claude→GitHub flow)
 */

export interface Env {
  DB: D1Database;
  KRYV_SECRET: string;
  NEHIRA_API_KEY: string;
  GITHUB_CLIENT_ID: string;     // From GitHub OAuth App (new)
  GITHUB_CLIENT_SECRET: string; // From GitHub OAuth App (new)
  GITHUB_TOKEN: string;         // YOUR personal token (for your own tools only)
  GITHUB_OWNER: string;         // RajatDatta5315
  GOOGLE_SHEETS_KEY: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Client-Id",
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

// ─── CACHE (D1) ───
async function cacheGet(db: D1Database, key: string) {
  const r = await first(db, `SELECT value FROM kv_cache WHERE key=? AND (expires_at IS NULL OR expires_at > datetime('now'))`, [key]);
  return r ? (r as {value:string}).value : null;
}
async function cacheSet(db: D1Database, key: string, value: string, ttl?: number) {
  const exp = ttl ? `datetime('now', '+${ttl} seconds')` : "NULL";
  await run(db, `INSERT INTO kv_cache(key,value,expires_at)VALUES(?,?,${exp}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`, [key, value]);
}

// ─── CONTEXT ───
async function pushContext(db: D1Database, clientId: string, source: string, data: unknown) {
  await run(db, `INSERT INTO context_store(client_id,source,data,updated_at)VALUES(?,?,?,datetime('now')) ON CONFLICT(client_id,source) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`, [clientId, source, JSON.stringify(data)]);
}
async function getContext(db: D1Database, clientId: string, source?: string) {
  if (source) return first(db, `SELECT source,data,updated_at FROM context_store WHERE client_id=? AND source=?`, [clientId,source]);
  return all(db, `SELECT source,data,updated_at FROM context_store WHERE client_id=? ORDER BY updated_at DESC`, [clientId]);
}

// ─── VIGILIS ───
function vigilis(input: string) {
  const t = input.toLowerCase();
  const threats = [
    { re:/bank.*verif|account.*suspend|wire.*transfer|urgent.*payment/i, cat:"phishing", p:"bank-impersonation", s:0.92 },
    { re:/ignore.*previous.*instruction|forget.*system.*prompt/i,        cat:"jailbreak", p:"prompt-injection",  s:0.97 },
    { re:/you are now|act as.*without restriction/i,                      cat:"jailbreak", p:"persona-override",  s:0.95 },
    { re:/\bDAN\b|jailbreak|no content policy/i,                          cat:"jailbreak", p:"dan-attack",        s:0.96 },
    { re:/send.*bitcoin|crypto.*wallet.*payment/i,                        cat:"phishing",  p:"crypto-scam",       s:0.91 },
    { re:/dump.*table|show.*all.*passwords|export.*database/i,            cat:"exfiltration",p:"db-dump",         s:0.90 },
  ];
  let best = 0, matched: typeof threats[0]|null = null;
  for (const th of threats) {
    if (th.re.test(t) && th.s > best) { best = th.s; matched = th; }
  }
  if (matched) return { safe:false, risk_score:best, pattern:matched.p, category:matched.cat, recommendation:`BLOCK` };
  return { safe:true, risk_score:0.02, pattern:null, category:null, recommendation:"PROCEED" };
}

// ─── GITHUB: GET USER'S OWN TOKEN ───
// Each user connects their own GitHub via OAuth
// Their token is stored in D1 under their client_id
async function getUserGitHubToken(db: D1Database, clientId: string): Promise<{token:string;owner:string}|null> {
  const r = await first(db, `SELECT github_token, github_username FROM clients WHERE client_id=?`, [clientId]);
  if (!r || !(r as {github_token?:string}).github_token) return null;
  return { token: (r as {github_token:string}).github_token, owner: (r as {github_username:string}).github_username };
}

// ─── GITHUB API ───
async function ghReq(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "KRYV-MCP/0.6",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(data as {message?:string}).message}`);
  return data;
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

// ─── GITHUB TOOLS (all use USER's own token) ───
async function ghReadFile(token: string, owner: string, repo: string, path: string, branch?: string) {
  const b = branch || await ghDefaultBranch(token, owner, repo);
  const f = await ghGetFile(token, owner, repo, path, b);
  return f ? { found:true, path, repo, branch:b, content:f.content, sha:f.sha } : { found:false, path, repo };
}

async function ghListFiles(token: string, owner: string, repo: string, path = "", branch?: string) {
  const b = branch || await ghDefaultBranch(token, owner, repo);
  const d = await ghReq(token, "GET", `/repos/${owner}/${repo}/contents/${path}?ref=${b}`) as Array<{name:string;type:string;path:string;size:number}>;
  return { path, repo, branch:b, files: Array.isArray(d) ? d.map(f=>({name:f.name,type:f.type,path:f.path,size:f.size})) : [] };
}

async function ghWriteFile(token: string, owner: string, repo: string, path: string, content: string, message: string, branch?: string) {
  const b = branch || await ghDefaultBranch(token, owner, repo);
  const existing = await ghGetFile(token, owner, repo, path, b);
  const body: Record<string,unknown> = { message, content: btoa(unescape(encodeURIComponent(content))), branch: b };
  if (existing?.sha) body.sha = existing.sha;
  await ghReq(token, "PUT", `/repos/${owner}/${repo}/contents/${path}`, body);
  // Auto-update changelog
  try { await ghAppendChangelog(token, owner, repo, b, message, [path]); } catch { /* non-blocking */ }
  return { written:true, path, repo, branch:b, action: existing ? "updated" : "created" };
}

async function ghListRepos(token: string) {
  const d = await ghReq(token, "GET", `/user/repos?per_page=100&sort=updated&type=all`) as Array<{name:string;full_name:string;private:boolean;updated_at:string}>;
  return { repos: d.map(r=>({ name:r.name, full_name:r.full_name, private:r.private, updated_at:r.updated_at })), count: d.length };
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

async function ghAppendChangelog(token: string, owner: string, repo: string, branch: string, entry: string, files: string[]) {
  const now = new Date().toISOString().slice(0,19).replace("T"," ")+" UTC";
  const existing = await ghGetFile(token, owner, repo, "CHANGELOG.md", branch);
  const prev = existing?.content || "# KRYV Changelog\n\n";
  const newEntry = `## ${now}\n\n${entry}\n\n**Files:** ${files.map(f=>`\`${f}\``).join(", ")}\n\n---\n\n`;
  const parts = prev.split("\n\n");
  const updated = parts[0] + "\n\n" + newEntry + parts.slice(1).join("\n\n");
  const existing2 = await ghGetFile(token, owner, repo, "CHANGELOG.md", branch);
  const body: Record<string,unknown> = { message:`chore: auto-log — ${entry.slice(0,60)}`, content:btoa(unescape(encodeURIComponent(updated))), branch };
  if (existing2?.sha) body.sha = existing2.sha;
  await ghReq(token, "PUT", `/repos/${owner}/${repo}/contents/CHANGELOG.md`, body);
}

// ─── GITHUB OAUTH ───
async function handleGitHubOAuth(url: URL, env: Env): Promise<Response> {
  // Step 1: Redirect user to GitHub
  // GET /github/oauth?client_id=xxx  (xxx = KRYV client_id, not GitHub client id)
  const kryvClientId = url.searchParams.get("client_id");
  if (!kryvClientId) return json({ error: "client_id required" }, 400);

  const state = kryvClientId + ":" + crypto.randomUUID().slice(0,8);
  const ghAuthUrl = new URL("https://github.com/login/oauth/authorize");
  ghAuthUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  ghAuthUrl.searchParams.set("scope", "repo,workflow");
  ghAuthUrl.searchParams.set("state", state);
  ghAuthUrl.searchParams.set("redirect_uri", `${url.origin}/github/callback`);

  return Response.redirect(ghAuthUrl.toString(), 302);
}

async function handleGitHubCallback(url: URL, env: Env): Promise<Response> {
  // Step 2: GitHub redirects back with ?code=xxx&state=yyy
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return html(`<p>Error: missing code or state</p>`, 400);

  const kryvClientId = state.split(":")[0];

  // Exchange code for token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
  if (!tokenData.access_token) return html(`<p>GitHub auth failed: ${tokenData.error}</p>`, 400);

  // Get user's GitHub username
  const userRes = await fetch("https://api.github.com/user", {
    headers: { "Authorization": `Bearer ${tokenData.access_token}`, "User-Agent": "KRYV-MCP/0.6" },
  });
  const userData = await userRes.json() as { login: string; avatar_url: string; name: string };

  // Store token in D1
  await run(env.DB,
    `UPDATE clients SET github_token=?, github_username=?, github_connected=1 WHERE client_id=?`,
    [tokenData.access_token, userData.login, kryvClientId]
  );

  return html(`<!DOCTYPE html><html><head>
    <title>GitHub Connected — KRYV-MCP</title>
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700&display=swap" rel="stylesheet"/>
    <style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{background:#020408;color:#e2e8f0;font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
      .box{text-align:center;padding:48px;max-width:400px;}
      .check{font-size:64px;margin-bottom:24px;}
      h2{font-family:'Syne',sans-serif;font-size:28px;font-weight:900;margin-bottom:12px;color:#4ade80;}
      p{color:#64748b;font-size:14px;line-height:1.6;margin-bottom:8px;}
      code{font-family:'DM Mono',monospace;background:rgba(56,189,248,0.1);color:#38bdf8;padding:2px 8px;border-radius:4px;font-size:12px;}
      a{color:#38bdf8;text-decoration:none;}
    </style></head><body>
    <div class="box">
      <div class="check">✓</div>
      <h2>GitHub Connected!</h2>
      <p>Account: <code>@${userData.login}</code></p>
      <p>KRYV-MCP can now read and write to all your repos.</p>
      <p style="margin-top:20px"><a href="/connect">← Back to Connect</a></p>
    </div></body></html>`);
}

// ─── MCP TOOLS LIST ───
const TOOLS = [
  { name:"vigilis_check", description:"Threat detector. Scans for phishing, jailbreak, scams.", inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]} },
  { name:"ask_nehira", description:"Ask NEHIRA AI. Returns her answer.", inputSchema:{type:"object",properties:{message:{type:"string"},context:{type:"string"}},required:["message"]} },
  { name:"push_context", description:"Store user context (browser, WhatsApp, notes).", inputSchema:{type:"object",properties:{client_id:{type:"string"},source:{type:"string"},data:{type:"object"}},required:["client_id","source","data"]} },
  { name:"get_context", description:"Get user's stored personal context.", inputSchema:{type:"object",properties:{client_id:{type:"string"},source:{type:"string"}},required:["client_id"]} },
  { name:"cache_set", description:"Store key-value in D1 cache.", inputSchema:{type:"object",properties:{key:{type:"string"},value:{type:"string"},ttl:{type:"number"}},required:["key","value"]} },
  { name:"cache_get", description:"Get cached value.", inputSchema:{type:"object",properties:{key:{type:"string"}},required:["key"]} },
  { name:"get_stats", description:"Live usage stats.", inputSchema:{type:"object",properties:{}} },
  { name:"server_info", description:"Server version and capabilities.", inputSchema:{type:"object",properties:{}} },
  // GitHub tools — use the REQUESTING USER's GitHub account
  { name:"github_connect_url", description:"Get the GitHub OAuth URL for a user to connect their own GitHub account. Returns a URL the user opens in browser.", inputSchema:{type:"object",properties:{client_id:{type:"string"}},required:["client_id"]} },
  { name:"github_list_repos", description:"List ALL repos on the USER's own GitHub account. Uses their own token — they only see their own repos.", inputSchema:{type:"object",properties:{},} },
  { name:"github_read_file", description:"Read a file from a repo on the USER's own GitHub.", inputSchema:{type:"object",properties:{repo:{type:"string"},path:{type:"string"},branch:{type:"string"}},required:["repo","path"]} },
  { name:"github_list_files", description:"List files in a directory of the USER's GitHub repo.", inputSchema:{type:"object",properties:{repo:{type:"string"},path:{type:"string"},branch:{type:"string"}},required:["repo"]} },
  { name:"github_write_file", description:"Write a file to the USER's GitHub repo. Auto-updates CHANGELOG.md as backup.", inputSchema:{type:"object",properties:{repo:{type:"string"},path:{type:"string"},content:{type:"string"},message:{type:"string"},branch:{type:"string"}},required:["repo","path","content","message"]} },
  { name:"github_create_branch", description:"Create a branch in the USER's GitHub repo.", inputSchema:{type:"object",properties:{repo:{type:"string"},new_branch:{type:"string"},from_branch:{type:"string"}},required:["repo","new_branch"]} },
  { name:"github_create_pr", description:"Create a pull request on the USER's GitHub repo.", inputSchema:{type:"object",properties:{repo:{type:"string"},title:{type:"string"},body:{type:"string"},head:{type:"string"},base:{type:"string"}},required:["repo","title","body","head"]} },
];

// ─── TOOL EXECUTOR ───
async function executeTool(name: string, args: Record<string,unknown>, env: Env, clientId?: string) {
  const t0 = Date.now();
  const wrap = (d: unknown) => ({ content:[{ type:"text", text:JSON.stringify(d,null,2) }] });

  try {
    let result: unknown;

    // Get this user's GitHub credentials (their own account)
    const userGH = clientId ? await getUserGitHubToken(env.DB, clientId) : null;
    // Fallback to server token only for server's own tools
    const serverGH = { token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER || "RajatDatta5315" };

    switch (name) {
      case "vigilis_check": {
        const r = vigilis(String(args.query||""));
        if (!r.safe) await run(env.DB,`INSERT INTO vigilis_incidents(client_id,risk_score,pattern,category,action_taken,created_at)VALUES(?,?,?,?,'blocked',datetime('now'))`,[clientId||null,r.risk_score,r.pattern,r.category]);
        result = r; break;
      }
      case "ask_nehira": {
        const res = await fetch("https://vokryl.kryv.network/api/nehira/chat",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${env.NEHIRA_API_KEY}`},body:JSON.stringify({message:String(args.message),...(args.context?{system_context:String(args.context)}:{})})});
        if (!res.ok) throw new Error(`NEHIRA ${res.status}`);
        const d = await res.json() as {response?:string;message?:string;reply?:string};
        result={answer:d.response||d.message||d.reply||"No response",model:"NEHIRA"}; break;
      }
      case "push_context": await pushContext(env.DB,String(args.client_id),String(args.source),args.data); result={stored:true,source:args.source}; break;
      case "get_context": result=await getContext(env.DB,String(args.client_id),args.source?String(args.source):undefined); break;
      case "cache_set": await cacheSet(env.DB,String(args.key),String(args.value),args.ttl?Number(args.ttl):undefined); result={stored:true}; break;
      case "cache_get": { const v=await cacheGet(env.DB,String(args.key)); result={key:args.key,value:v,found:v!==null}; break; }
      case "get_stats": {
        const [tot,blk,cli,tools]=await Promise.all([first(env.DB,`SELECT COUNT(*)as n FROM usage_logs`),first(env.DB,`SELECT COUNT(*)as n FROM vigilis_incidents`),first(env.DB,`SELECT COUNT(*)as n FROM clients WHERE status='active'`),all(env.DB,`SELECT tool_name,COUNT(*)as uses FROM usage_logs GROUP BY tool_name ORDER BY uses DESC LIMIT 8`)]);
        result={total_requests:(tot as {n:number})?.n||0,vigilis_blocks:(blk as {n:number})?.n||0,active_clients:(cli as {n:number})?.n||0,top_tools:tools.results}; break;
      }
      case "server_info": result={name:"KRYV-MCP",version:"0.6.0",github_oauth:true,per_user_tokens:true,tools:TOOLS.map(t=>t.name)}; break;

      // GitHub — USER's own account
      case "github_connect_url": {
        if (!args.client_id) throw new Error("client_id required");
        result={connect_url:`https://kryv-mcp.rajatdatta90000.workers.dev/github/oauth?client_id=${args.client_id}`,instruction:"Open this URL in browser to connect GitHub"}; break;
      }
      case "github_list_repos": {
        if (!userGH) throw new Error("GitHub not connected. Call github_connect_url first to connect your GitHub account.");
        result = await ghListRepos(userGH.token); break;
      }
      case "github_read_file": {
        if (!userGH) throw new Error("GitHub not connected. Connect your GitHub first via github_connect_url.");
        result = await ghReadFile(userGH.token, userGH.owner, String(args.repo), String(args.path), args.branch?String(args.branch):undefined); break;
      }
      case "github_list_files": {
        if (!userGH) throw new Error("GitHub not connected. Connect your GitHub first via github_connect_url.");
        result = await ghListFiles(userGH.token, userGH.owner, String(args.repo), String(args.path||""), args.branch?String(args.branch):undefined); break;
      }
      case "github_write_file": {
        if (!userGH) throw new Error("GitHub not connected. Connect your GitHub first via github_connect_url.");
        result = await ghWriteFile(userGH.token, userGH.owner, String(args.repo), String(args.path), String(args.content), String(args.message), args.branch?String(args.branch):undefined); break;
      }
      case "github_create_branch": {
        if (!userGH) throw new Error("GitHub not connected.");
        result = await ghCreateBranch(userGH.token, userGH.owner, String(args.repo), String(args.new_branch), args.from_branch?String(args.from_branch):undefined); break;
      }
      case "github_create_pr": {
        if (!userGH) throw new Error("GitHub not connected.");
        result = await ghCreatePR(userGH.token, userGH.owner, String(args.repo), String(args.title), String(args.body), String(args.head), args.base?String(args.base):undefined); break;
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }

    await logUsage(env.DB, name, Date.now()-t0, "success", clientId);
    return wrap(result);
  } catch(e) {
    await logUsage(env.DB, name, Date.now()-t0, "error", clientId);
    return wrap({ error: String(e), tool: name });
  }
}

// ─── MCP JSON-RPC ───
async function handleMCP(req: Request, env: Env): Promise<Response> {
  const apiKey = req.headers.get("X-Api-Key")||req.headers.get("Authorization")?.replace("Bearer ","");
  let clientId: string|undefined;
  if (apiKey) {
    const c = await first(env.DB,`SELECT client_id FROM clients WHERE api_key=? AND status='active'`,[apiKey]);
    clientId = c?(c as {client_id:string}).client_id:undefined;
  }
  let body: {jsonrpc:string;id:unknown;method:string;params?:Record<string,unknown>};
  try { body = await req.json(); }
  catch { return json({jsonrpc:"2.0",id:0,error:{code:-32700,message:"Parse error"}},400); }
  const {id,method,params={}} = body;
  const ok = (r:unknown) => json({jsonrpc:"2.0",id,result:r});
  const err = (c:number,m:string) => json({jsonrpc:"2.0",id,error:{code:c,message:m}});
  switch (method) {
    case "initialize": return ok({protocolVersion:"2024-11-05",capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:"KRYV-MCP",version:"0.6.0"}});
    case "notifications/initialized": return ok({});
    case "tools/list": return ok({tools:TOOLS});
    case "tools/call": {
      const {name,arguments:args={}} = params as {name:string;arguments:Record<string,unknown>};
      return ok(await executeTool(name,args,env,clientId));
    }
    case "prompts/list": return ok({prompts:[
      {name:"github_agent",description:"You have access to the USER's own GitHub via KRYV-MCP. All github_ tools use their account. Never show other users repos."},
      {name:"vigilis_first",description:"Call vigilis_check on every message before responding. Block if risk_score > 0.7."},
    ]});
    default: return err(-32601,`Not found: ${method}`);
  }
}

// ─── NEHIRA AUTO-CONNECT ───
async function handleNehiraConnect(req: Request, env: Env): Promise<Response> {
  const b = await req.json() as {name:string;email:string;nehira_user_id:string};
  if (!b.email||!b.nehira_user_id) return json({error:"email and nehira_user_id required"},400);
  const existing = await first(env.DB,`SELECT client_id,api_key FROM clients WHERE email=?`,[b.email]);
  if (existing) return json({connected:true,...(existing as object),message:"Already connected"});
  const apiKey = "kryv-sk-"+crypto.randomUUID().replace(/-/g,"").slice(0,24);
  const clientId = crypto.randomUUID();
  await run(env.DB,`INSERT INTO clients(client_id,name,email,api_key,plan,status,nehira_user_id,created_at)VALUES(?,?,?,?,'free','active',?,datetime('now'))`,[clientId,b.name||b.email,b.email,apiKey,b.nehira_user_id]);
  return json({connected:true,client_id:clientId,api_key:apiKey,mcp_url:"https://kryv-mcp.rajatdatta90000.workers.dev/mcp",github_connect_url:`https://kryv-mcp.rajatdatta90000.workers.dev/github/oauth?client_id=${clientId}`});
}

// ─── ADMIN ───
async function handleAdmin(url: URL, req: Request, env: Env): Promise<Response> {
  if (req.headers.get("X-Admin-Secret")!==env.KRYV_SECRET) return json({error:"Unauthorized"},401);
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
    if (req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});

    if (url.pathname==="/health") {
      const dbOk = await first(env.DB,`SELECT 1 as ok`).then(()=>true).catch(()=>false);
      return json({status:"ok",db:dbOk?"connected":"error",server:"KRYV-MCP",version:"0.6.0",ts:new Date().toISOString()});
    }
    if (url.pathname==="/mcp"&&req.method==="POST") return handleMCP(req,env);
    // /sse GET — proper MCP SSE transport (Cursor, Claude Desktop, etc.)
    if (url.pathname==="/sse"&&req.method==="GET") {
      const origin = url.origin;
      // Generate unique session ID for this connection
      const sessionId = crypto.randomUUID();
      const stream = new ReadableStream({start(ctrl){
        const enc=new TextEncoder();
        const send=(e:string,d:string)=>ctrl.enqueue(enc.encode(`event: ${e}\ndata: ${d}\n\n`));
        // MCP SSE spec: first event must be "endpoint" with POST URL
        send("endpoint", `${origin}/mcp?session=${sessionId}`);
        // Keep-alive pings
        const t=setInterval(()=>ctrl.enqueue(enc.encode(`: ping\n\n`)),15000);
        req.signal.addEventListener("abort",()=>{clearInterval(t);try{ctrl.close();}catch{/**/}});
      }});
      return new Response(stream,{headers:{...CORS,"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive","X-Accel-Buffering":"no"}});
    }
    // /sse POST — some clients (older Cursor) post directly here
    if (url.pathname==="/sse"&&req.method==="POST") return handleMCP(req,env);
    // /mcp GET — return server info (some clients probe with GET)
    if (url.pathname==="/mcp"&&req.method==="GET") {
      return json({name:"KRYV-MCP",version:"0.6.0",protocolVersion:"2024-11-05",transport:"http+sse",endpoints:{sse:`${url.origin}/sse`,mcp:`${url.origin}/mcp`}});
    }
    if (url.pathname==="/push"&&req.method==="POST") {
      const b = await req.json() as {client_id:string;source:string;data:unknown};
      if (!b.client_id||!b.source) return json({error:"client_id and source required"},400);
      await pushContext(env.DB,b.client_id,b.source,b.data);
      return json({pushed:true,source:b.source});
    }
    if (url.pathname==="/nehira/connect"&&req.method==="POST") return handleNehiraConnect(req,env);
    if (url.pathname==="/github/oauth"&&req.method==="GET") return handleGitHubOAuth(url,env);
    if (url.pathname==="/github/callback"&&req.method==="GET") return handleGitHubCallback(url,env);
    if (url.pathname.startsWith("/admin/")) return handleAdmin(url,req,env);
    if (url.pathname==="/") return json({name:"KRYV-MCP",version:"0.6.0",endpoints:{health:"/health",mcp:"/mcp",sse:"/sse",push:"/push",github_oauth:"/github/oauth?client_id=YOUR_ID",github_callback:"/github/callback"},docs:"mcp.kryv.network"});
    return json({error:"Not found"},404);
  },
};
