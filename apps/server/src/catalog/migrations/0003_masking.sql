-- Настройка маскирования персональных данных: переключатель и добавленные поля вида. Встроенные поля — в коде.
-- Вид без списка значений в check: новый вид не требует миграции. Строки создаёт ensureProject при подключении.
create table catalog_masking (
  id         bigint generated always as identity primary key,
  project_id text not null references catalog_project on delete cascade,
  type       text not null check (type ~ '^[a-z][a-z0-9_]{0,31}$'),
  enabled    boolean not null default true,
  keys       text[] not null default '{}',
  edited     boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  unique (project_id, type)
);

-- Строки «Неизвестного», собранные раньше, могли содержать открытые персональные данные.
delete from catalog_unknown;
