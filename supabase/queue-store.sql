create table if not exists public.automation_jobs (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.automation_intakes (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.automation_settings (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists automation_jobs_status_run_at_idx
  on public.automation_jobs (
    ((data->>'status')),
    ((data->>'runAt'))
  );

create index if not exists automation_intakes_status_updated_idx
  on public.automation_intakes (
    ((data->>'status')),
    updated_at desc
  );

create index if not exists automation_settings_updated_idx
  on public.automation_settings (
    updated_at desc
  );

alter table public.automation_jobs enable row level security;
alter table public.automation_intakes enable row level security;

-- The app and GitHub Actions use SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- Do not expose the service role key in browser code.
