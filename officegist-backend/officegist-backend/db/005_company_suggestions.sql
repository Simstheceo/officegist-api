-- Companies suggested by users. An admin reviews each one; approving it creates the real company.
BEGIN;

CREATE TABLE IF NOT EXISTS company_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  industry text NOT NULL,
  city text NOT NULL,
  state text,
  website text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  company_slug text,                      -- set when approved
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The same company cannot be waiting for review twice.
CREATE UNIQUE INDEX IF NOT EXISTS company_suggestions_one_pending_name ON company_suggestions (lower(name)) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS company_suggestions_pending_idx ON company_suggestions (created_at) WHERE status = 'PENDING';

COMMIT;
