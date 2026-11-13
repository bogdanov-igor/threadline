-- Проекты в базе.
-- catalog_project не получает внешний ключ на project: записи проекта, убранного из настройки, остаются.

create table project (
  id             text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  name           text not null,
  timezone       text not null,
  retention_days int  not null check (retention_days between 1 and 400),
  format         text not null,
  environments   jsonb not null,         -- массив: порядок сред важен, объект в jsonb его теряет
  position       int  not null,
  hidden_by      text check (hidden_by in ('page', 'file')),
  from_file      boolean not null default false,
  edited         boolean not null default false,
  file_hash      text,                   -- версия файла, которую видели последней
  updated_at     timestamptz not null default clock_timestamp()
);

create table project_logo (
  project_id   text not null references project on delete cascade,
  theme        text not null check (theme in ('light', 'dark')),
  content      bytea not null check (octet_length(content) <= 262144),
  content_type text not null check (content_type in ('image/png', 'image/svg+xml')),
  ratio        double precision not null check (ratio > 0),
  hash         text not null,
  primary key (project_id, theme)
);

create table project_deleted (project_id text primary key);   -- удалён на странице, файл не возвращает

create table project_meta (only_row boolean primary key default true check (only_row), version bigint not null default 1);
insert into project_meta default values;
