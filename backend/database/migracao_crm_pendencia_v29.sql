-- v29 · Pendência de estoque na venda (CRM e outbound)
--
-- Quando a venda é ganha e não há material para tudo, o comercial decide entre
-- seguir com o disponível ou aguardar a produção. O saldo que ficou de fora vira
-- PENDÊNCIA: a OV vai para operações de vendas só com o que existe, e o resto
-- entra depois como 2ª remessa (mesmo numero_pedido, NF própria).
--
-- jsonb em vez de tabela nova pelo mesmo motivo de licitacao_demandas.estoque: o
-- registro é sempre lido junto da oportunidade, nunca isolado, e o formato ainda
-- vai mudar conforme o processo assenta. Uma tabela cobraria migration a cada
-- ajuste de campo.
--
-- Formato:
-- {
--   "decisao": "PARCIAL" | "AGUARDAR",
--   "origem": "GANHO" | "MANUAL",
--   "decidido_em": "2026-08-06T12:00:00+00:00",
--   "decidido_por": "<uuid>",
--   "observacao": "...",
--   "valor": 4780.00,                     -- valor do saldo pendente
--   "itens": [ { "produto_id", "codigo", "descricao",
--                "qtd_pedida", "qtd_atendida", "qtd_pendente",
--                "valor_unitario", "valor_pendente" } ],
--   "previsao_sa": "2026-08-10",          -- semiacabado virando PA (~2 dias úteis)
--   "resolvido_em": null,                 -- preenchido ao liberar
--   "resolucao": null                     -- "REMESSA_2" | "SOMADO_R1"
-- }

-- O MESMO formato em duas tabelas, porque há dois caminhos até a venda e cada um
-- tem um dono natural para o registro:
--
--   crm_oportunidades  venda ganha no CRM. Guarda aqui porque na decisão
--                      "aguardar produção" NÃO existe OV nenhuma para pendurar a
--                      pendência — a oportunidade é o único registro que existe.
--   pedidos            venda outbound, lançada direto pelo comercial sem passar
--                      pelo CRM. Não há oportunidade; a OV é o registro.
--
-- O formato é idêntico de propósito: pendencia_service lê, lista e libera as duas
-- com o mesmo código.
alter table crm_oportunidades
    add column if not exists pendencia jsonb;

alter table pedidos
    add column if not exists pendencia jsonb;

-- A pendência aberta é consultada em toda abertura do painel (kanban do CRM e aba
-- do Painel Comercial). Índice parcial: só as linhas que têm pendência, que são
-- poucas em relação ao total.
create index if not exists idx_crm_opp_pendencia_aberta
    on crm_oportunidades ((pendencia is not null))
    where pendencia is not null;

create index if not exists idx_pedidos_pendencia_aberta
    on pedidos ((pendencia is not null))
    where pendencia is not null;

comment on column crm_oportunidades.pendencia is
    'Saldo de material que faltou na venda ganha. NULL = sem pendência. '
    'resolvido_em preenchido = pendência já liberada (histórico).';

comment on column pedidos.pendencia is
    'Idem, para venda outbound (lançada sem passar pelo CRM). Mesmo formato.';
