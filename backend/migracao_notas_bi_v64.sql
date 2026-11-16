-- v64 — Base de Notas Fiscais do BI, item a item.
--
-- O espelho do D365 (notas_d365) resolve a NOTA: número, valor, data, cliente.
-- Ele não resolve o ITEM — e é no item que mora quase toda pergunta comercial:
-- quanto saiu de cada produto, a que preço, para quem, em que linha, por qual
-- vendedor. Hoje isso o app deduz dos itens da OV, e as OVs pararam de nascer
-- aqui (ver cargas_portal, v63).
--
-- A base do BI fecha essa lacuna. Medido no arquivo de novembro/2026:
--   · 134 linhas de item, 105 notas, 43 produtos — TODOS os 43 já existem no
--     cadastro de produtos do app;
--   · Sales Vertical traduz 100% para a linha do app;
--   · traz quantidade e preço por item, que o espelho fiscal não tem;
--   · traz devolução com número interno (MSB-001885), que não é NF e por isso
--     não aparece no espelho do D365 — era uma das devoluções que o app não
--     conseguia classificar.
--
-- Esta tabela é ESPELHO e ENRIQUECIMENTO, nunca uma segunda fonte de receita.
-- O faturamento continua saindo de onde sai hoje. Somar as duas contaria a
-- mesma venda duas vezes, que é o erro mais caro que este app pode cometer.

CREATE TABLE IF NOT EXISTS notas_bi_itens (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- A identidade da linha. O BI numera cada item da fatura; o par
    -- (fatura, item) não se repete. Reimportar o mesmo mês atualiza.
    numero_fatura       TEXT NOT NULL,
    seq_item            TEXT NOT NULL,

    empresa             TEXT,
    unidade_negocio     TEXT,
    -- AAAAMM, como o BI entrega. O arquivo é mensal.
    competencia         TEXT,
    data_faturamento    DATE,

    -- Vem quase sempre como "SEM COMISSIONAMENTO": em novembro/2026 só 14 das
    -- 134 linhas tinham vendedor de verdade. A coluna existe, o dado é raro —
    -- e é por isso que "vendas por vendedor" ainda não é uma pergunta que esta
    -- base responde sozinha.
    comissionado        TEXT,
    vendedor            TEXT,

    -- UROLOGIA, GENERAL SALES, PI & CI. Guardado cru.
    sales_vertical      TEXT,
    -- A tradução para o vocabulário do app, medida contra o cadastro de
    -- produtos em 16/11/2026, sem uma única divergência:
    --   UROLOGIA      -> URO        (28 de 28)
    --   GENERAL SALES -> VASCULAR   (64 de 64)
    --   PI & CI       -> VASCULAR   (39 de 39)
    -- O BI separa mais fino que o app: GENERAL SALES e PI & CI são duas
    -- verticais que caem na mesma linha daqui. A tradução perde esse detalhe
    -- de propósito — as metas são por linha —, e o cru fica ao lado para o dia
    -- em que a meta passar a separar.
    linha               TEXT,

    paciente            TEXT,
    -- VENDA DIRETA, VENDA FUTURA, NÃO CLASSIFICADO.
    classificacao       TEXT,
    operacao            TEXT,
    -- ÓRGÃO PÚBLICO, DISTRIBUIDOR, VENDA DIRETA.
    tipo_cliente        TEXT,

    cliente_codigo      TEXT,
    cliente_nome        TEXT,
    cliente_faturamento TEXT,
    uf                  TEXT,
    cidade              TEXT,

    familia             TEXT,
    produto_codigo      TEXT,
    produto_nome        TEXT,
    produto_id          UUID REFERENCES produtos(id),

    -- Negativo é devolução. Vem assim do BI e fica assim aqui: inverter o
    -- sinal na importação esconderia a devolução dentro da venda.
    valor               NUMERIC(14, 2),
    quantidade          NUMERIC(14, 2),
    preco               NUMERIC(14, 4),
    margem_frete        NUMERIC(14, 4),

    arquivo             TEXT,
    importado_em        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    importado_por       UUID REFERENCES usuarios(id),
    criado_em           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    atualizado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT notas_bi_itens_identidade UNIQUE (numero_fatura, seq_item)
);

CREATE INDEX IF NOT EXISTS idx_bi_competencia ON notas_bi_itens(competencia);
CREATE INDEX IF NOT EXISTS idx_bi_data        ON notas_bi_itens(data_faturamento);
CREATE INDEX IF NOT EXISTS idx_bi_fatura      ON notas_bi_itens(numero_fatura);
CREATE INDEX IF NOT EXISTS idx_bi_produto     ON notas_bi_itens(produto_codigo);
CREATE INDEX IF NOT EXISTS idx_bi_cliente     ON notas_bi_itens(cliente_codigo);
CREATE INDEX IF NOT EXISTS idx_bi_linha       ON notas_bi_itens(linha);

COMMENT ON TABLE notas_bi_itens IS
    'Base de Notas Fiscais do BI, uma linha por item faturado. Enriquece o '
    'espelho fiscal com quantidade, preco, produto, vertical e vendedor. '
    'NAO e fonte de receita: somar com notas_d365 contaria a venda duas vezes.';

COMMENT ON COLUMN notas_bi_itens.valor IS
    'Negativo = devolucao, como o BI entrega. O sinal nao e invertido.';

COMMENT ON COLUMN notas_bi_itens.numero_fatura IS
    'Numero da NF, ou o documento interno (MSB-001885) quando a devolucao nao '
    'tem NF propria — por isso TEXTO, e por isso nem toda linha casa com '
    'notas_d365.';
