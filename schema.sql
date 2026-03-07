-- Ghost Buster SaaS: Database Schema
-- Run this once on your Railway Postgres instance

-- Burner accounts used for scraping
CREATE TABLE IF NOT EXISTS burner_accounts (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  session_json JSONB NOT NULL,          -- Playwright cookie array
  status       TEXT NOT NULL DEFAULT 'active', -- 'active' | 'banned' | 'expired'
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SaaS users who receive notifications
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  webhook_url TEXT NOT NULL,            -- Discord or Slack webhook
  max_risk    INTEGER NOT NULL DEFAULT 40, -- Max risk score (0-100) to forward
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_burner_status ON burner_accounts (status);
CREATE INDEX IF NOT EXISTS idx_users_active  ON users (is_active);
