-- Rastreio das entregas CIF: o acompanhamento que hoje vive no sistema da BRIX
-- e no grupo de WhatsApp da RR passa a ficar registrado na OV.
--
-- Um evento por linha, lancado pela equipe. O estado atual de cada carga sai do
-- evento mais recente; a data de entrega e o recebedor ficam no proprio evento,
-- para que a prova de entrega nao dependa de ninguem lembrar da conversa.

create table if not exists rastreios (
  id                  uuid primary key default gen_random_uuid(),
  pedido_id           uuid not null references pedidos(id) on delete cascade,
  -- EM_TRANSITO, SAIU_PARA_ENTREGA, AGENDADA, ENTREGUE, COMPROVANTE_RECEBIDO,
  -- OCORRENCIA, RECUSADA, EXTRAVIO, DEVOLUCAO, SEM_INFORMACAO
  situacao            text not null,
  -- quando aconteceu (nao quando foi digitado): a BRIX informa data e hora do
  -- status, e a RR responde no grupo horas depois da entrega
  ocorrido_em         timestamptz not null default now(),
  -- de onde veio a informacao: BRIX_SISTEMA, RR_WHATSAPP, CLIENTE, OUTRO
  fonte               text,
  descricao           text,
  recebedor           text,
  documento_recebedor text,
  -- quando a transportadora repactua o prazo
  nova_previsao       date,
  usuario_id          uuid references usuarios(id),
  criado_em           timestamptz not null default now()
);

create index if not exists idx_rastreios_pedido on rastreios (pedido_id, ocorrido_em desc);
create index if not exists idx_rastreios_situacao on rastreios (situacao);

alter table rastreios enable row level security;

drop policy if exists rastreios_leitura on rastreios;
create policy rastreios_leitura on rastreios for select using (true);

drop policy if exists rastreios_escrita on rastreios;
create policy rastreios_escrita on rastreios for all using (true) with check (true);
