-- ============================================================
-- KRYV-MCP Oracle Cloud Database Setup
-- File: oracle-setup.sql
-- Run this in Oracle Cloud → Database Actions → SQL Worksheet
-- (Always-Free tier — no credit card charge ever)
-- ============================================================

-- ── 1. CLIENTS TABLE ──
-- Stores everyone who buys access to your MCP bridge
CREATE TABLE kryv_clients (
    id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id     VARCHAR2(36) DEFAULT SYS_GUID() NOT NULL UNIQUE,
    name          VARCHAR2(255) NOT NULL,
    email         VARCHAR2(255) NOT NULL UNIQUE,
    api_key       VARCHAR2(64) NOT NULL UNIQUE,  -- hash this in production
    plan          VARCHAR2(20) DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
    status        VARCHAR2(20) DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
    monthly_price NUMBER(10,2) DEFAULT 0,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 2. DATA SOURCES TABLE ──
-- Every Google Sheet or DB a client has connected
CREATE TABLE kryv_sources (
    id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id     VARCHAR2(36) DEFAULT SYS_GUID() NOT NULL UNIQUE,
    client_id     VARCHAR2(36) NOT NULL REFERENCES kryv_clients(client_id),
    name          VARCHAR2(255) NOT NULL,
    type          VARCHAR2(30) CHECK (type IN ('google_sheets','postgresql','mysql','notion','airtable','rest_api')),
    connection    CLOB,  -- JSON: sheet_id, url, credentials (encrypted)
    status        VARCHAR2(20) DEFAULT 'active',
    last_synced   TIMESTAMP,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 3. USAGE LOGS TABLE ──
-- Every MCP request logged for billing and analytics
CREATE TABLE kryv_usage_logs (
    id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id     VARCHAR2(36),
    tool_name     VARCHAR2(100),
    request_hash  VARCHAR2(64),  -- SHA-256 of request for dedup
    vigilis_safe  NUMBER(1),     -- 1=safe, 0=blocked
    response_ms   NUMBER,        -- response time in ms
    status        VARCHAR2(20),  -- success, error, blocked
    ip_hash       VARCHAR2(64),
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 4. VIGILIS INCIDENTS TABLE ──
-- Every threat detected by VIGILIS
CREATE TABLE kryv_vigilis_incidents (
    id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id     VARCHAR2(36),
    input_hash    VARCHAR2(64),  -- never store raw input
    risk_score    NUMBER(4,3),
    pattern       VARCHAR2(100),
    category      VARCHAR2(50),
    action_taken  VARCHAR2(50) DEFAULT 'blocked',
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 5. SUBSCRIPTIONS TABLE ──
-- For billing (when you start charging)
CREATE TABLE kryv_subscriptions (
    id              NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id       VARCHAR2(36) NOT NULL REFERENCES kryv_clients(client_id),
    plan            VARCHAR2(20) NOT NULL,
    price_usd       NUMBER(10,2),
    billing_cycle   VARCHAR2(20) DEFAULT 'monthly',
    start_date      DATE DEFAULT SYSDATE,
    next_billing    DATE,
    payment_ref     VARCHAR2(255),
    status          VARCHAR2(20) DEFAULT 'active'
);

-- ── INDEXES for performance ──
CREATE INDEX idx_usage_client ON kryv_usage_logs(client_id);
CREATE INDEX idx_usage_date   ON kryv_usage_logs(created_at);
CREATE INDEX idx_vigilis_date ON kryv_vigilis_incidents(created_at);
CREATE INDEX idx_sources_client ON kryv_sources(client_id);

-- ── ENABLE REST on all tables (Oracle ORDS) ──
-- Run each of these after creating tables:
BEGIN
  ORDS.ENABLE_OBJECT(
    p_enabled      => TRUE,
    p_schema       => 'KRYV',           -- your schema name
    p_object       => 'KRYV_CLIENTS',
    p_object_type  => 'TABLE',
    p_object_alias => 'clients',
    p_auto_rest_auth => FALSE
  );
  COMMIT;
END;
/

BEGIN
  ORDS.ENABLE_OBJECT(
    p_enabled      => TRUE,
    p_schema       => 'KRYV',
    p_object       => 'KRYV_USAGE_LOGS',
    p_object_type  => 'TABLE',
    p_object_alias => 'usage_logs',
    p_auto_rest_auth => FALSE
  );
  COMMIT;
END;
/

BEGIN
  ORDS.ENABLE_OBJECT(
    p_enabled      => TRUE,
    p_schema       => 'KRYV',
    p_object       => 'KRYV_VIGILIS_INCIDENTS',
    p_object_type  => 'TABLE',
    p_object_alias => 'vigilis_incidents',
    p_auto_rest_auth => FALSE
  );
  COMMIT;
END;
/

-- ── SEED: Insert your first client (yourself) ──
INSERT INTO kryv_clients (name, email, api_key, plan, monthly_price)
VALUES ('KRYV Admin', 'hello@kryv.network', 'kryv-sk-your-secret-key-here', 'enterprise', 0);
COMMIT;

-- ── TEST QUERIES ──
SELECT * FROM kryv_clients;
SELECT COUNT(*) FROM kryv_usage_logs;
