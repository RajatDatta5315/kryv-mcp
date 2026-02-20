/**
 * KRYV-MCP × NEHIRA Integration
 * File: nehira-mcp-connector.ts
 * 
 * Add this to NEHIRA's source code.
 * Before NEHIRA answers any question, it calls KRYV-MCP
 * to get the user's real context. Zero hallucination.
 * 
 * INTEGRATION STEPS:
 * 1. Copy this file into your NEHIRA project
 * 2. Import KryvConnector and call enrichContext() before LLM call
 * 3. Add the connector settings panel to NEHIRA's UI
 */

// ─────────────────────────────────────────
// CONFIG (loaded from NEHIRA user settings)
// ─────────────────────────────────────────
interface KryvConfig {
  serverUrl: string;      // e.g. https://mcp.kryv.network/mcp
  clientId: string;       // user's KRYV client ID
  enabled: boolean;
  vigilisFirst: boolean;  // run VIGILIS check before answering
  contextSources: string[]; // which sources to fetch: browser_tabs, whatsapp, notes, files
}

interface ContextResult {
  grounded: boolean;
  context: string;        // formatted context to inject into prompt
  sources: string[];      // which sources were used
  vigilis?: {
    safe: boolean;
    risk_score: number;
    recommendation: string;
  };
}

// ─────────────────────────────────────────
// MCP CLIENT — call KRYV-MCP via JSON-RPC
// ─────────────────────────────────────────
async function mcpCall(
  serverUrl: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const res = await fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`KRYV-MCP error: ${res.status}`);
  const data = await res.json() as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function callTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await mcpCall(serverUrl, "tools/call", { name: toolName, arguments: args }) as {
    content: Array<{ type: string; text: string }>
  };
  return result?.content?.[0]?.text || "{}";
}

// ─────────────────────────────────────────
// MAIN: ENRICH CONTEXT FOR NEHIRA
// Call this BEFORE sending user message to LLM
// ─────────────────────────────────────────
export async function enrichContext(
  userMessage: string,
  config: KryvConfig
): Promise<ContextResult> {
  if (!config.enabled || !config.serverUrl || !config.clientId) {
    return { grounded: false, context: "", sources: [] };
  }

  const usedSources: string[] = [];
  const contextParts: string[] = [];
  let vigilisResult = undefined;

  try {
    // 1. VIGILIS check first (if enabled)
    if (config.vigilisFirst) {
      const vRaw = await callTool(config.serverUrl, "vigilis_check", { query: userMessage });
      const v = JSON.parse(vRaw);
      vigilisResult = { safe: v.safe, risk_score: v.risk_score, recommendation: v.recommendation };

      if (!v.safe && v.risk_score > 0.7) {
        return {
          grounded: false,
          context: "",
          sources: [],
          vigilis: vigilisResult,
        };
      }
    }

    // 2. Fetch user context from all registered sources
    if (config.contextSources.length > 0) {
      for (const source of config.contextSources) {
        try {
          const ctxRaw = await callTool(config.serverUrl, "get_user_context", {
            client_id: config.clientId,
            source,
          });
          const ctx = JSON.parse(ctxRaw) as { data?: string; source?: string } | null;
          if (ctx && ctx.data) {
            const parsed = typeof ctx.data === "string" ? JSON.parse(ctx.data) : ctx.data;
            contextParts.push(`[${source.toUpperCase()}]\n${formatSource(source, parsed)}`);
            usedSources.push(source);
          }
        } catch {
          // Source not available, skip silently
        }
      }
    }

    // 3. Format final context injection
    if (contextParts.length === 0) {
      return { grounded: false, context: "", sources: [], vigilis: vigilisResult };
    }

    const context = buildContextPrompt(contextParts, usedSources);

    return { grounded: true, context, sources: usedSources, vigilis: vigilisResult };

  } catch (err) {
    console.warn("KRYV-MCP connector error:", err);
    return { grounded: false, context: "", sources: [], vigilis: vigilisResult };
  }
}

// ─────────────────────────────────────────
// FORMAT CONTEXT FOR LLM INJECTION
// ─────────────────────────────────────────
function formatSource(source: string, data: Record<string, unknown>): string {
  switch (source) {
    case "browser_tabs":
      const tabs = (data.tabs as Array<{title:string;url:string;active:boolean}> || []).slice(0, 10);
      return tabs.map(t => `- ${t.active ? "[ACTIVE]" : ""} ${t.title} (${t.domain || t.url})`).join("\n");

    case "browser_history":
      const hist = (data.history as Array<{title:string;domain:string;visits:number}> || []).slice(0, 15);
      return hist.map(h => `- ${h.title} | ${h.domain} (${h.visits} visits)`).join("\n");

    case "whatsapp":
      const chats = (data.chats as Array<{name:string;last_active:string}> || []).slice(0, 10);
      return `Active chat: ${data.active_chat || "none"}\nRecent chats: ${chats.map(c => c.name).join(", ")}`;

    case "local_notes":
      const notes = (data.notes as Array<{name:string;preview:string}> || []).slice(0, 5);
      return notes.map(n => `- ${n.name}:\n  "${n.preview}"`).join("\n");

    case "local_files":
      const files = (data.recent_files as Array<{name:string;type:string;modified:string}> || []).slice(0, 10);
      return files.map(f => `- ${f.name} (${f.type}, modified ${f.modified.slice(0,10)})`).join("\n");

    default:
      return JSON.stringify(data, null, 2).slice(0, 500);
  }
}

function buildContextPrompt(parts: string[], sources: string[]): string {
  return `
=== NEHIRA CONTEXT (via KRYV-MCP) ===
The following is real, live context from the user's device.
Use this to ground your answer. Do not guess or hallucinate.
Sources: ${sources.join(", ")}

${parts.join("\n\n")}
=== END CONTEXT ===

`.trim();
}

// ─────────────────────────────────────────
// INJECT INTO NEHIRA PROMPT
// ─────────────────────────────────────────
export function buildNehiraPrompt(
  userMessage: string,
  context: ContextResult,
  systemPrompt = ""
): { system: string; user: string } {
  const system = [
    systemPrompt || "You are NEHIRA, an intelligent AI assistant.",
    context.grounded
      ? "You have access to the user's real-time personal context below. Always use it when relevant."
      : "Answer based on your knowledge.",
    context.vigilis?.safe === false
      ? `⚠️ VIGILIS WARNING: Risk score ${context.vigilis.risk_score}. ${context.vigilis.recommendation}`
      : "",
  ].filter(Boolean).join("\n\n");

  const user = context.grounded
    ? `${context.context}\n\nUser question: ${userMessage}`
    : userMessage;

  return { system, user };
}

// ─────────────────────────────────────────
// EXAMPLE USAGE IN NEHIRA
// ─────────────────────────────────────────
/*

// In NEHIRA's main chat handler:
import { enrichContext, buildNehiraPrompt } from "./nehira-mcp-connector";

async function handleUserMessage(userMessage: string, userConfig: KryvConfig) {
  // 1. Get grounded context from KRYV-MCP
  const context = await enrichContext(userMessage, userConfig);

  // 2. If VIGILIS blocked it, return warning immediately
  if (context.vigilis && !context.vigilis.safe && context.vigilis.risk_score > 0.7) {
    return {
      response: `⚠️ NEHIRA detected a potential threat in this message. ${context.vigilis.recommendation}`,
      blocked: true,
    };
  }

  // 3. Build grounded prompt
  const { system, user } = buildNehiraPrompt(userMessage, context);

  // 4. Call your LLM (Claude, Gemini, GPT — whatever NEHIRA uses)
  const response = await yourLLM.call({ system, user });

  return { response, grounded: context.grounded, sources: context.sources };
}

*/

// ─────────────────────────────────────────
// NEHIRA SETTINGS UI COMPONENT (React)
// Add this to NEHIRA's settings page
// ─────────────────────────────────────────
export const NEHIRA_SETTINGS_TEMPLATE = `
// Add to NEHIRA settings/connectors page:

const [kryv, setKryv] = useState({
  enabled: false,
  serverUrl: "https://mcp.kryv.network/mcp",
  clientId: "",
  vigilisFirst: true,
  contextSources: ["browser_tabs", "local_notes"],
});

// Settings UI:
<div className="connector-card">
  <div className="connector-header">
    <span>⬡ KRYV-MCP</span>
    <toggle value={kryv.enabled} onChange={v => setKryv({...kryv, enabled: v})} />
  </div>
  <input placeholder="Server URL" value={kryv.serverUrl} onChange={...} />
  <input placeholder="Your Client ID" value={kryv.clientId} onChange={...} />
  <checkbox label="VIGILIS security screen" value={kryv.vigilisFirst} />
  <multiselect
    label="Context sources"
    options={["browser_tabs","browser_history","whatsapp","local_notes","local_files"]}
    value={kryv.contextSources}
  />
</div>
`;
