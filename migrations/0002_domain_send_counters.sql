-- Atomically reserve weekly courtesy-cap slots per recipient domain.
-- This closes the race where multiple queue consumers could each observe a
-- domain below its cap and send at the same time.

CREATE TABLE domain_send_counters (
  week_start TEXT NOT NULL,                       -- Monday in the configured send timezone
  domain     TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week_start, domain)
);
