-- Отметки записей файла, удалённых навсегда. Иначе новый файл добавил бы такую запись снова.
-- Так же устроен project_deleted. Запись без seed_key отметки не даёт, новое создание записи с тем же ключом снимает отметку.

create table catalog_deleted (
  project_id text not null references catalog_project on delete cascade,
  kind       text not null,
  seed_key   text not null,
  primary key (project_id, kind, seed_key)
);
