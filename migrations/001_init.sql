CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  display_username TEXT NOT NULL,
  wallet_chain TEXT NOT NULL DEFAULT 'evm' CHECK (wallet_chain IN ('evm', 'solana')),
  wallet_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raffles (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  winner_count INTEGER NOT NULL CHECK (winner_count > 0),
  chain TEXT NOT NULL DEFAULT 'evm' CHECK (chain IN ('evm', 'solana')),
  status TEXT NOT NULL CHECK (status IN ('created', 'open', 'drawing', 'completed')) DEFAULT 'created',
  created_by BIGINT NOT NULL,
  announcement_chat_id BIGINT,
  all_entrants_win BOOLEAN NOT NULL DEFAULT FALSE,
  reward_token TEXT,
  reward_total_amount NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  next_hourly_alert_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS raffle_entries (
  id SERIAL PRIMARY KEY,
  raffle_id INTEGER NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_chain TEXT,
  wallet_address TEXT,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(raffle_id, user_id)
);

CREATE TABLE IF NOT EXISTS raffle_winners (
  id SERIAL PRIMARY KEY,
  raffle_id INTEGER NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  payout_status TEXT NOT NULL DEFAULT 'pending' CHECK (payout_status IN ('pending', 'paid')),
  payout_tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(raffle_id, rank),
  UNIQUE(raffle_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_raffle_entries_raffle_id ON raffle_entries(raffle_id);
CREATE INDEX IF NOT EXISTS idx_raffle_winners_raffle_id ON raffle_winners(raffle_id);

CREATE SEQUENCE IF NOT EXISTS admin_payout_wallets_id_seq;

CREATE TABLE IF NOT EXISTS admin_payout_wallets (
  id INTEGER PRIMARY KEY DEFAULT nextval('admin_payout_wallets_id_seq'::regclass),
  admin_telegram_user_id BIGINT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('evm', 'solana')),
  mode TEXT NOT NULL CHECK (mode IN ('native', 'token')),
  secret TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(admin_telegram_user_id, chain, mode)
);

ALTER SEQUENCE admin_payout_wallets_id_seq OWNED BY admin_payout_wallets.id;

ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_chain TEXT;
ALTER TABLE users ALTER COLUMN wallet_chain SET DEFAULT 'evm';
UPDATE users SET wallet_chain = 'evm' WHERE wallet_chain IS NULL;
ALTER TABLE users ALTER COLUMN wallet_chain SET NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS evm_wallet_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS solana_wallet_address TEXT;
UPDATE users
SET evm_wallet_address = wallet_address
WHERE wallet_chain = 'evm'
  AND evm_wallet_address IS NULL;
UPDATE users
SET solana_wallet_address = wallet_address
WHERE wallet_chain = 'solana'
  AND solana_wallet_address IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_wallet_chain_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_wallet_chain_check CHECK (wallet_chain IN ('evm', 'solana'));
  END IF;
END $$;

ALTER TABLE raffle_entries ADD COLUMN IF NOT EXISTS wallet_chain TEXT;
ALTER TABLE raffle_entries ADD COLUMN IF NOT EXISTS wallet_address TEXT;

UPDATE raffle_entries e
SET wallet_chain = r.chain
FROM raffles r
WHERE e.raffle_id = r.id
  AND e.wallet_chain IS NULL;

UPDATE raffle_entries e
SET wallet_address = CASE
  WHEN e.wallet_chain = 'evm' THEN u.evm_wallet_address
  WHEN e.wallet_chain = 'solana' THEN u.solana_wallet_address
  ELSE u.wallet_address
END
FROM users u
WHERE e.user_id = u.id
  AND e.wallet_address IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'raffle_entries_wallet_chain_check'
      AND conrelid = 'raffle_entries'::regclass
  ) THEN
    ALTER TABLE raffle_entries
      ADD CONSTRAINT raffle_entries_wallet_chain_check CHECK (wallet_chain IN ('evm', 'solana'));
  END IF;
END $$;

ALTER TABLE raffle_entries ALTER COLUMN wallet_chain SET NOT NULL;
ALTER TABLE raffle_entries ALTER COLUMN wallet_address SET NOT NULL;

ALTER TABLE raffles ADD COLUMN IF NOT EXISTS chain TEXT;
ALTER TABLE raffles ALTER COLUMN chain SET DEFAULT 'evm';
UPDATE raffles SET chain = 'evm' WHERE chain IS NULL;
ALTER TABLE raffles ALTER COLUMN chain SET NOT NULL;

ALTER TABLE raffles ADD COLUMN IF NOT EXISTS announcement_chat_id BIGINT;
ALTER TABLE raffles ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE raffles ADD COLUMN IF NOT EXISTS next_hourly_alert_at TIMESTAMPTZ;
ALTER TABLE raffles ADD COLUMN IF NOT EXISTS all_entrants_win BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE raffles ADD COLUMN IF NOT EXISTS reward_token TEXT;
ALTER TABLE raffles ADD COLUMN IF NOT EXISTS reward_total_amount NUMERIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'raffles_chain_check'
      AND conrelid = 'raffles'::regclass
  ) THEN
    ALTER TABLE raffles
      ADD CONSTRAINT raffles_chain_check CHECK (chain IN ('evm', 'solana'));
  END IF;
END $$;
