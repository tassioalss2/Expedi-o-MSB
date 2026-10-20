-- v56 — Agendamento de coleta/entrega, e a transportadora da carga.
--
-- Contrato novo com a BRIX (20/10/2026): a MSB fatura com o nome deles e manda
-- a carga no grupo do WhatsApp. Uma das informações que o grupo precisa é se
-- aquela entrega tem HORA MARCADA — na licitação, o órgão costuma agendar o
-- recebimento, e entregar fora da janela significa carga recusada e frete pago
-- duas vezes.
--
-- `data_prevista_coleta`, que já existe, é outra coisa: é quando a
-- transportadora deve passar aqui. Este campo é o compromisso com o cliente.

alter table public.pedidos
  add column if not exists coleta_agendada_em  timestamptz,
  add column if not exists coleta_agendada_obs text;

comment on column public.pedidos.coleta_agendada_em is
  'Data e hora marcadas com o cliente/órgão para a entrega (ou para a coleta no '
  'destino). Nulo = sem agendamento, entrega em horário comercial.';
comment on column public.pedidos.coleta_agendada_obs is
  'O que o agendamento exige: protocolo, setor, documento, janela de horário.';

create index if not exists idx_pedidos_coleta_agendada
  on public.pedidos (coleta_agendada_em)
  where coleta_agendada_em is not null;
