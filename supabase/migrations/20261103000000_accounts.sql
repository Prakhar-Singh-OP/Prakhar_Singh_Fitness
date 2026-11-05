CREATE TABLE IF NOT EXISTS psf_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('coach', 'client')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS psf_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES psf_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS psf_sessions_account_id_idx ON psf_sessions(account_id);
CREATE INDEX IF NOT EXISTS psf_sessions_expires_at_idx ON psf_sessions(expires_at);

CREATE TABLE IF NOT EXISTS psf_coach_workspaces (
  coach_id UUID PRIMARY KEY REFERENCES psf_accounts(id) ON DELETE CASCADE,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS psf_workspace_versions (
  coach_id UUID PRIMARY KEY REFERENCES psf_accounts(id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS psf_clients (
  id TEXT PRIMARY KEY,
  coach_id UUID NOT NULL REFERENCES psf_accounts(id) ON DELETE CASCADE,
  linked_account_id UUID UNIQUE REFERENCES psf_accounts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT clients_id_length CHECK (char_length(id) BETWEEN 1 AND 100),
  CONSTRAINT clients_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT clients_email_length CHECK (char_length(email) <= 254)
);
CREATE INDEX IF NOT EXISTS psf_clients_coach_id_idx ON psf_clients(coach_id);

CREATE TABLE IF NOT EXISTS psf_client_invites (
  token_hash TEXT PRIMARY KEY,
  coach_id UUID NOT NULL REFERENCES psf_accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES psf_clients(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS psf_client_invites_client_id_idx ON psf_client_invites(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS psf_client_invites_one_open_per_client_idx
  ON psf_client_invites(client_id) WHERE redeemed_at IS NULL;

CREATE TABLE IF NOT EXISTS psf_auth_attempts (
  identifier_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS psf_auth_attempts_lookup_idx ON psf_auth_attempts(identifier_hash, created_at);

CREATE TABLE IF NOT EXISTS psf_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES psf_accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES psf_clients(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  adherence INTEGER NOT NULL CHECK (adherence BETWEEN 0 AND 100),
  workouts_completed INTEGER NOT NULL CHECK (workouts_completed BETWEEN 0 AND 14),
  energy INTEGER NOT NULL CHECK (energy BETWEEN 1 AND 5),
  notes TEXT NOT NULL DEFAULT '',
  coach_response TEXT NOT NULL DEFAULT '',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  coach_replied_at TIMESTAMPTZ,
  UNIQUE (client_id, week_start),
  CONSTRAINT checkins_notes_length CHECK (char_length(notes) <= 1000),
  CONSTRAINT checkins_response_length CHECK (char_length(coach_response) <= 1000)
);
CREATE INDEX IF NOT EXISTS psf_checkins_coach_week_idx ON psf_checkins(coach_id, week_start DESC);

CREATE TABLE IF NOT EXISTS psf_password_resets (
  token_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES psf_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS psf_password_resets_account_id_idx ON psf_password_resets(account_id);
CREATE INDEX IF NOT EXISTS psf_password_resets_expires_at_idx ON psf_password_resets(expires_at);

INSERT INTO psf_workspace_versions (coach_id)
SELECT id FROM psf_accounts WHERE role = 'coach'
ON CONFLICT (coach_id) DO NOTHING;

ALTER TABLE psf_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE psf_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE psf_coach_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE psf_workspace_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE psf_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE psf_client_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE psf_auth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE psf_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE psf_password_resets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE psf_accounts, psf_sessions, psf_coach_workspaces, psf_workspace_versions,
  psf_clients, psf_client_invites, psf_auth_attempts, psf_checkins, psf_password_resets FROM anon, authenticated;
