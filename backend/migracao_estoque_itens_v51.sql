-- ─────────────────────────────────────────────────────────────────────────────
-- v51 — O que falta numa solicitação passa a ser PRODUTO, não texto livre
--
-- Hoje a marca "sem estoque" guarda uma frase em `estoque_obs`. Nos 10 casos
-- marcados agora ela está assim:
--
--     51382          51394          53053          73346
--     51394 - 25 UNID               Todos          (vazio, em 2 casos)
--
-- Às vezes o código, às vezes código e quantidade, às vezes "Todos", às vezes
-- nada. O app não sabe de que produto se trata, então não consegue somar no
-- comprometido, cruzar com o PCP nem mostrar essa falta junto das pendências de
-- OV — que foi o que o Tássio pediu e que depende disto.
--
-- `estoque_itens` guarda a escolha ligada ao cadastro:
--   [{"produto_id": "...", "codigo": "51382", "descricao": "...", "qtd": 25}]
--
-- `estoque_obs` FICA. Não é redundância: ele continua servindo para o que não é
-- produto ("aguardando posição do PCP", "cliente vai remanejar") e guarda o
-- texto dos 10 casos antigos, que ninguém vai reescrever.
-- ─────────────────────────────────────────────────────────────────────────────

alter table licitacao_entrada
    add column if not exists estoque_itens jsonb;

comment on column licitacao_entrada.estoque_itens is
    'O que falta, ligado ao cadastro: [{produto_id, codigo, descricao, qtd}]. '
    'Vazio quando ninguém especificou — a marca de falta continua valendo.';
