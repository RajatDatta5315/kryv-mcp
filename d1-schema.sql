-- ============================================================
-- KRYV-MCP — Cloudflare D1 Schema
-- File: d1-schema.sql
-- 
-- HOW TO RUN:
-- Cloudflare Dashboard → D1 → Your DB → Console → paste & run
-- OR via Wrangler: npx wrangler d1 execute KRYV_DB --file=d1-schema.sql
-- ============================================================

-- Clients (paying users / subscribers)
CREATE TABLE IF NOT EXISTS clients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT    NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  name             TEXT    NOT NULL,
  email            TEXT    NOT NULL UNIQUE,
  api_key          TEXT    NOT NULL UNIQUE,
  plan             TEXT    NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','enterprise')),
  status           TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','cancelled')),
  monthly_price_usd REAL   DEFAULT 0,
  created_at       TEXT    DEFAULT (datetime('now'))
);

-- Usage logs (every MCP request)
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

-- VIGILIS incidents (every threat detected)
CREATE TABLE IF NOT EXISTS vigilis_incidents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT,
  risk_score   REAL,
  pattern      TEXT,
  category     TEXT,
  action_taken TEXT DEFAULT 'blocked',
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Context store (Chrome Extension / Oracle agent pushes here)
CREATE TABLE IF NOT EXISTS context_store (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT    NOT NULL,
  source      TEXT    NOT NULL,   -- browser_tabs, whatsapp, notes, files, chrome_history
  data        TEXT    NOT NULL,   -- JSON blob
  updated_at  TEXT    DEFAULT (datetime('now')),
  UNIQUE(client_id, source)       -- one entry per source per client, updated in place
);

-- Data source registrations
CREATE TABLE IF NOT EXISTS data_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT    NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(8)))),
  client_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  type        TEXT    CHECK(type IN ('google_sheets','notion','rest_api','chrome_ext','oracle_agent','local_files')),
  config      TEXT,               -- JSON: sheet_id, url, etc
  status      TEXT    DEFAULT 'active',
  last_sync   TEXT,
  created_at  TEXT    DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_logs_client    ON usage_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_logs_date      ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_tool      ON usage_logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_vigilis_date   ON vigilis_incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_context_client ON context_store(client_id);
CREATE INDEX IF NOT EXISTS idx_sources_client ON data_sources(client_id);

-- Seed: your own admin client
INSERT OR IGNORE INTO clients (name, email, api_key, plan, monthly_price_usd)
VALUES ('KRYV Admin', 'hello@kryv.network', 'kryv-sk-admin-changethis', 'enterprise', 0);
