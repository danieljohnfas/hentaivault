-- Migration: 0007_add_affiliate_clicks.sql
-- Real-time conversion & outbound telemetry tracking for PureVPN and pCloud affiliate partners

CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner TEXT NOT NULL,          -- 'purevpn' | 'pcloud'
  slot TEXT NOT NULL,             -- 'navbar', 'region-unblock', 'mylist-backup', 'directory-card', etc.
  target_url TEXT NOT NULL,
  referer TEXT,
  country TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_partner ON affiliate_clicks(partner);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_created ON affiliate_clicks(created_at);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_slot ON affiliate_clicks(slot);
