-- ============================================================
-- KRYV-MCP D1 Schema v2 — d1-schema.sql
-- Run in: Cloudflare → D1 → kryv-mcp-db → Console → Run All
-- ============================================================

-- Clients
CREATE TABLE IF NOT EXISTS clients (
  id                INTEGER  PRIMARY KEY AUTOINCREMENT,
  client_id         TEXT     NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  name              TEXT     NOT NULL,
  email             TEXT     NOT NULL UNIQUE,
  api_key           TEXT     NOT NULL UNIQUE,
  plan              TEXT     NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','enterprise')),
  status            TEXT     NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','cancelled')),
  monthly_price_usd REAL     DEFAULT 0,
  nehira_user_id    TEXT,    -- NEHIRA user ID for auto-connect
  created_at        TEXT     DEFAULT (datetime('now'))
);

-- Usage logs
CREATE TABLE IF NOT EXISTS usage_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT,
  tool_name    TEXT,
  vigilis_safe INTEGER DEFAULT 1,
  response_ms  INTEGER,
  status       TEXT,
  ip_hash      TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- VIGILIS incidents
CREATE TABLE IF NOT EXISTS vigilis_incidents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT,
  risk_score   REAL,
  pattern      TEXT,
  category     TEXT,
  action_taken TEXT DEFAULT 'blocked',
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Context store (browser tabs, WhatsApp, notes, files)
CREATE TABLE IF NOT EXISTS context_store (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL,
  source      TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(client_id, source)
);

-- KV Cache (replaces Cloudflare KV — no daily limit issues)
CREATE TABLE IF NOT EXISTS kv_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Data sources
CREATE TABLE IF NOT EXISTS data_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(8)))),
  client_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT CHECK(type IN ('google_sheets','notion','rest_api','chrome_ext','oracle_agent','local_files','whatsapp')),
  config      TEXT,
  status      TEXT DEFAULT 'active',
  last_sync   TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_logs_client    ON usage_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_logs_date      ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_tool      ON usage_logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_vigilis_date   ON vigilis_incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_context_client ON context_store(client_id);
CREATE INDEX IF NOT EXISTS idx_context_source ON context_store(source);
CREATE INDEX IF NOT EXISTS idx_kv_expires     ON kv_cache(expires_at);

-- Seed: your admin client
INSERT OR IGNORE INTO clients (name, email, api_key, plan, monthly_price_usd)
VALUES ('KRYV Admin', 'hello@kryv.network', 'kryv-sk-admin-changethis-now', 'enterprise', 0);
