-- Managed domains: domains the user has transferred to Botflow's CF account
CREATE TABLE IF NOT EXISTS user_domains (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  apex_domain   text NOT NULL,
  cf_zone_id    text,
  status        text NOT NULL DEFAULT 'pending_ns',
  nameservers   jsonb,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_domains_user_apex_unique ON user_domains (user_id, apex_domain);
CREATE INDEX IF NOT EXISTS user_domains_user_id_idx ON user_domains (user_id);

-- DNS records within a managed domain's zone
CREATE TABLE IF NOT EXISTS domain_dns_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES user_domains(id) ON DELETE CASCADE,
  cf_record_id  text,
  type          text NOT NULL,
  name          text NOT NULL,
  content       text NOT NULL,
  ttl           integer NOT NULL DEFAULT 1,
  priority      integer,
  proxied       boolean NOT NULL DEFAULT false,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS domain_dns_records_domain_id_idx ON domain_dns_records (domain_id);

-- Add managed-domain assignment fields to projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS managed_domain_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS managed_domain_hostname text;
