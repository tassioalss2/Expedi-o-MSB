-- v18 (27/07/2026): histórico de faturamento para a previsão estatística.
--
-- O app só tem movimentações desde 06/2026, o que dá 1 mês completo — pouco
-- para projetar fechamento de mês. Esta tabela recebe o histórico anterior
-- (2025 em diante), exportado do D365, com granularidade DIÁRIA: é o que
-- permite montar a curva de ritmo do mês (quanto do total costuma estar
-- faturado a X% dos dias úteis) além da média/sazonalidade.
--
-- Se só houver totais mensais, lance uma linha por mês (ex.: dia 01) — a média
-- e a sazonalidade já funcionam; só a curva de ritmo fica de fora.
--
-- Regra de uso no serviço: um mês que já tem dados no app usa o app; os demais
-- vêm daqui. Nunca soma as duas fontes no mesmo mês (evita dobrar valor).
-- Idempotente.
create table if not exists faturamento_historico (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  -- Faturamento líquido do dia (mesma base do app: NF sem o frete CIF sem valor).
  valor numeric(14,2) not null default 0,
  -- Transfer price fica de fora da meta; marque true para não contaminar a base.
  transfer boolean not null default false,
  canal text,
  origem text default 'IMPORT_D365',
  observacao text,
  criado_em timestamptz default now()
);

create index if not exists idx_faturamento_historico_data on faturamento_historico (data);
create index if not exists idx_faturamento_historico_transfer on faturamento_historico (transfer);
