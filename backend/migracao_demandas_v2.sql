alter table licitacao_demandas add column if not exists ref_externa text;
update licitacao_demandas set etapa = 'RECEBIDO' where etapa in ('NOVO', 'ANALISE');
