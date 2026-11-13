-- Настройка вида проекта. Живёт в строке проекта, файл настроек о ней не знает.
-- Посев и «Взять из файла» перечисляют столбцы явно и этих двух не касаются, updated_at проекта она не трогает.

alter table project add column view_settings jsonb;          -- null: встроенные значения
alter table project add column view_updated_at timestamptz;  -- null: ни разу не сохраняли
