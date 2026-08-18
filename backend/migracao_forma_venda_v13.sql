-- v13 — Separa O QUE foi vendido de COMO foi vendido.
--
-- O campo `canal` misturava duas perguntas diferentes:
--   O QUE  -> Uro / Vascular / Realclosure  (o SKU sabe: produtos.linha)
--   COMO   -> venda direta ou licitação     (só a pessoa sabe)
--
-- A parte do O QUE passa a ser calculada a partir dos itens da OV (rateio por
-- linha), então a meta deixa de depender do que foi digitado. Sobra o COMO, que
-- ganha coluna própria aqui.
--
-- `canal` NÃO é removido: continua gravado (derivado dos itens) para o histórico,
-- os rótulos das telas e as OVs antigas.

alter table pedidos add column if not exists forma_venda text;

-- Backfill: o canal legado já carrega o COMO no prefixo LICITACAO_.
update pedidos
   set forma_venda = case
       when canal like 'LICITACAO%' then 'LICITACAO'
       when canal is not null        then 'DIRETA'
       else null
   end
 where forma_venda is null;

create index if not exists idx_pedidos_forma_venda on pedidos (forma_venda);
