-- v8 (20/07/2026): controle de "sem estoque" no painel de licitações.
-- Guarda a previsão do PCP + itens faltantes na demanda. O card vai para a
-- coluna "Aguardando estoque (PCP)" e não sai do painel até o estoque chegar
-- (evita esquecer o pedido e tomar multa por atraso). Idempotente.
alter table licitacao_demandas add column if not exists estoque jsonb;
