-- v10 (20/07/2026): pregão como identificador mestre também na demanda.
-- O pregão rege o contrato; a NE (nota de empenho, campo `numero`) é secundária.
-- Um pregão pode ter várias NEs (empenhos). Idempotente.
alter table licitacao_demandas add column if not exists numero_pregao text;
