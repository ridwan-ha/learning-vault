create table public.vault_drive_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  encrypted_refresh_token text not null,
  updated_at timestamptz not null default now()
);

alter table public.vault_drive_credentials enable row level security;

revoke all privileges on table public.vault_drive_credentials from public, anon, authenticated;
grant all privileges on table public.vault_drive_credentials to service_role;
