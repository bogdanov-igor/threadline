-- Короткие ссылки и настройки сервиса.
-- Автора, счётчиков и времени открытия нет намеренно: это был бы журнал. Результатов и записей логов здесь не бывает.

create table share_link (
  id         text primary key,
  kind       text not null check (kind in ('results', 'request', 'operation')),
  project_id text not null,                 -- без внешнего ключа: проект из файла и убранный из настройки остаются законными
  env_id     text not null,
  stand      text,
  terms      jsonb not null default '[]',   -- значения поиска; номера карт только краями
  from_at    timestamptz not null,
  to_at      timestamptz not null,
  target     jsonb,                         -- request: { cid }; operation: { type, values, also, window }
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index share_link_expires on share_link (expires_at);

create table service_setting (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);
