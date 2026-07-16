alter table empenhos add column if not exists tipo text default 'CONSIGNACAO';
update empenhos set tipo = 'CONSIGNACAO' where tipo is null;
