-- Справочник методов, систем и ошибок.

create table catalog_project (
  project_id text primary key,
  version    bigint not null default 1,
  seed_hash  text
);

create table catalog_system (
  id          bigint generated always as identity primary key,
  project_id  text not null references catalog_project on delete cascade,
  key         text not null check (key ~ '^[a-z0-9-]{1,32}$'),
  kind        text not null check (kind in ('project', 'external')),
  type        text not null default 'service' check (type in ('service', 'database', 'queue')),
  name        text not null,
  hosts       text[] not null default '{}',
  description text,
  seed_key    text,
  edited      boolean not null default false,
  hidden      boolean not null default false,
  updated_at  timestamptz not null default clock_timestamp(),
  unique (project_id, key),
  check (kind = 'external' or type = 'service')
);
create unique index catalog_system_author on catalog_system (project_id) where kind = 'project';
create unique index catalog_system_seed on catalog_system (project_id, seed_key) where seed_key is not null;

create table catalog_id_type (
  id          bigint generated always as identity primary key,
  project_id  text not null references catalog_project on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  kind        text not null check (kind in ('entity', 'operation')),
  name        text not null,
  statuses    jsonb not null default '[]',
  seed_key    text,
  edited      boolean not null default false,
  hidden      boolean not null default false,
  updated_at  timestamptz not null default clock_timestamp(),
  unique (project_id, key),
  check (kind = 'operation' or statuses = '[]'::jsonb)
);
create unique index catalog_id_type_seed on catalog_id_type (project_id, seed_key) where seed_key is not null;

create table catalog_method (
  id          bigint generated always as identity primary key,
  project_id  text not null references catalog_project on delete cascade,
  system_id   bigint not null references catalog_system on delete cascade,
  http_method text not null,
  path        text not null,
  path_key    text not null,
  rpc         text not null default '',
  name        text not null,
  domain      text,
  description text,
  kind        text not null default 'call' check (kind in ('call', 'start', 'status', 'callback')),
  op_type     text,
  fields      jsonb not null default '[]',
  status_at   jsonb,
  seed_key    text,
  edited      boolean not null default false,
  hidden      boolean not null default false,
  updated_at  timestamptz not null default clock_timestamp(),
  unique (system_id, http_method, path_key, rpc),
  check (kind = 'call' or op_type is not null)
);
create index catalog_method_project on catalog_method (project_id);
create unique index catalog_method_seed on catalog_method (project_id, seed_key) where seed_key is not null;

create table catalog_error (
  id           bigint generated always as identity primary key,
  project_id   text not null references catalog_project on delete cascade,
  system_id    bigint references catalog_system on delete cascade,
  method_id    bigint references catalog_method on delete cascade,
  http_status  int check (http_status between 100 and 599),
  code         text,
  code_key     text,
  text_match   text,
  title        text not null,
  action       text,
  severity     text not null default 'error' check (severity in ('error', 'ok')),
  partner_code text,
  seed_key     text,
  edited       boolean not null default false,
  hidden       boolean not null default false,
  updated_at   timestamptz not null default clock_timestamp(),
  check (http_status is not null or code is not null or text_match is not null),
  check (method_id is null or system_id is not null)
);
create unique index catalog_error_rule on catalog_error
  (project_id, coalesce(system_id, 0), coalesce(method_id, 0), coalesce(http_status, 0), coalesce(code_key, ''), lower(coalesce(text_match, '')));
create unique index catalog_error_seed on catalog_error (project_id, seed_key) where seed_key is not null;

create table catalog_outcome_rule (
  id          bigint generated always as identity primary key,
  project_id  text not null references catalog_project on delete cascade,
  system_id   bigint references catalog_system on delete cascade,
  method_id   bigint references catalog_method on delete cascade,
  priority    int not null default 100 check (priority between 1 and 1000),
  conditions  jsonb not null,
  cond_key    text not null,
  outcome     text not null check (outcome in ('success', 'error', 'pending', 'ignore')),
  text        text,
  action      text,
  seed_key    text,
  edited      boolean not null default false,
  hidden      boolean not null default false,
  updated_at  timestamptz not null default clock_timestamp(),
  check (method_id is null or system_id is not null)
);
create unique index catalog_outcome_rule_cond on catalog_outcome_rule
  (project_id, coalesce(system_id, 0), coalesce(method_id, 0), cond_key);
create unique index catalog_outcome_rule_seed on catalog_outcome_rule (project_id, seed_key) where seed_key is not null;

create table catalog_unknown (
  id          bigint generated always as identity primary key,
  project_id  text not null references catalog_project on delete cascade,
  key         text not null,
  kind        text not null check (kind in ('method', 'host', 'error')),
  system_id   bigint references catalog_system on delete cascade,
  method_id   bigint references catalog_method on delete cascade,
  http_method text,
  path        text,
  rpc         text,
  host        text,
  http_status int,
  code        text,
  text        text,
  env         text not null,
  example_cid text not null,
  example_ms  bigint not null,
  count       bigint not null,
  first_seen  timestamptz not null,
  last_seen   timestamptz not null,
  hidden      boolean not null default false,
  unique (project_id, key)
);
create index catalog_unknown_top on catalog_unknown (project_id, hidden, count desc);
create index catalog_unknown_seen on catalog_unknown (project_id, last_seen);
