-- v9 (20/07/2026): nº do pregão no contrato/empenho, separado do nº do
-- contrato/empenho (NE). Um pregão (ex: 90051/2025) pode gerar vários empenhos.
-- Idempotente.
alter table empenhos add column if not exists numero_pregao text;
