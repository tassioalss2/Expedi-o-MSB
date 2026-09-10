-- v45 · O app lembra qual produto é a descrição do órgão
--
-- O documento do órgão traz a descrição CATMAT, que é genérica de propósito e
-- serve para vários itens, e quase nunca o nosso código. Medido na janela de
-- 01/07 a 10/09/2026: dos 7 códigos citados nos documentos, 3 existem no
-- catálogo. Nos outros, o produto só sai de quem conhece o pregão — e é por
-- isso que a v44 (janela do "gerar demanda") passou a perguntar.
--
-- Perguntar uma vez é necessário. Perguntar sempre é desperdício:
--
--     itens com descrição na janela ...........  118
--     descrições distintas ....................   80
--     descrições que REPETEM ..................   16  (cobrindo 54 itens)
--     a que mais repete .......................   18x ("BOMBA DEFLATORA
--                                                      SERINGA PROTESE E
--                                                      MATERIAIS...")
--
-- São ~38 escolhas repetidas em dez semanas, sempre a mesma resposta.
--
-- POR QUE VÁRIAS LINHAS PARA A MESMA DESCRIÇÃO, e não uma só:
-- a descrição CATMAT é ampla ("calibre de 6.5FR a 12FR") e legitimamente cobre
-- mais de um SKU. Forçar um único produto por descrição transformaria a
-- primeira escolha em verdade permanente — e escolha errada gravada como
-- verdade é pior que pergunta repetida, porque some da vista. Aqui cada
-- (descrição, contrato, produto) é um CANDIDATO com um contador; a tela sugere
-- o mais usado e continua deixando trocar.
--
-- O CONTRATO é o escopo, e não o cliente: o mesmo hospital compra por pregões
-- diferentes, e é o pregão que define qual item é qual. `contrato` nulo é o
-- caso em que o e-mail não citou contrato — a sugestão então vale como pista
-- mais fraca, e a tela diz isso.
CREATE TABLE IF NOT EXISTS licitacao_item_produto (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Como o órgão escreveu, sem tocar: é o que permite conferir a sugestão.
    descricao      text NOT NULL,
    -- A chave de comparação: maiúsculas, sem acento, sem pontuação, espaços
    -- colapsados. Normalizada pelo app (a mesma `_norm` da caixa de entrada),
    -- para a regra de comparação viver num lugar só.
    descricao_norm text NOT NULL,
    -- Contrato MSB citado no e-mail ("MSB-000329"). Nulo quando não citou.
    contrato       text,
    -- Guardado por informação, não como chave: ajuda a explicar de onde veio a
    -- sugestão quando alguém perguntar.
    cliente_id     uuid REFERENCES clientes(id),
    produto_id     uuid NOT NULL REFERENCES produtos(id),
    -- Quantas vezes esta escolha foi confirmada gerando demanda. É o que
    -- ordena as sugestões.
    vezes          integer NOT NULL DEFAULT 1,
    criado_por     uuid REFERENCES usuarios(id),
    criado_em      timestamptz NOT NULL DEFAULT now(),
    usado_em       timestamptz NOT NULL DEFAULT now()
);

-- md5 e não a coluna direta: a descrição vem do documento do órgão e já chega
-- com 400 caracteres. Índice btree em texto estoura acima de ~2700 bytes, e o
-- erro apareceria como INSERT recusado no meio de uma triagem, no dia em que um
-- órgão mandar um descritivo comprido.
CREATE UNIQUE INDEX IF NOT EXISTS ux_licitacao_item_produto
    ON licitacao_item_produto (md5(descricao_norm), coalesce(contrato, ''), produto_id);

-- A leitura é sempre "o que já escolhemos para esta descrição".
CREATE INDEX IF NOT EXISTS ix_licitacao_item_produto_desc
    ON licitacao_item_produto (md5(descricao_norm));

COMMENT ON TABLE licitacao_item_produto IS
    'De-para entre a descrição que o órgão escreve no documento (CATMAT) e o '
    'produto do nosso catálogo. Alimentado pela escolha de gente ao gerar '
    'demanda; é sugestão, nunca decisão automática.';
COMMENT ON COLUMN licitacao_item_produto.vezes IS
    'Quantas vezes esta escolha foi confirmada. Ordena as sugestões — a mais '
    'usada primeiro.';
COMMENT ON COLUMN licitacao_item_produto.contrato IS
    'Escopo da escolha: o contrato MSB citado no e-mail. O mesmo hospital '
    'compra por pregões diferentes, e é o pregão que define qual item é qual. '
    'Nulo = o e-mail não citou contrato, e a sugestão vale como pista fraca.';
