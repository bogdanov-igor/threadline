-- Номер стенда примера: ссылка «Открыть пример» у среды со стендами PR.
-- Строки, собранные раньше, удаляются: в них путь, код и действие могли остаться без маскирования.
alter table catalog_unknown add column stand text;
delete from catalog_unknown;
