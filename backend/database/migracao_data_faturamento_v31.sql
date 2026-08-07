-- v31 · Data de faturamento explícita na OV (competência do faturamento)
--
-- A competência era DEDUZIDA das movimentações: a primeira que levasse a FATURADO.
-- Essa dedução tem dois modos de falha opostos, e o app já sofreu os dois:
--
--   última movimentação  → toda correção em OV faturada (trocar transportadora,
--                          corrigir valor) criava uma movimentação FATURADO nova e
--                          a venda contava DE NOVO no mês da correção.
--                          Caso real: 3 OVs de julho reapareceram em agosto,
--                          R$ 4.939,84.
--   primeira movimentação → escolhida como correção do caso acima, mas erra quando
--                          a OV é REFATURADA. Caso real: OV016168 foi faturada em
--                          31/07 com a NF 20289 (emprestada de outra OV, erro),
--                          revertida em 04/08 e refaturada em 05/08 com a NF real
--                          20307. A competência ficou em julho, então R$ 5.600
--                          entraram no mês errado — sobrando em julho e faltando
--                          em agosto, contra o D365.
--
-- Não existe heurística sobre o histórico que acerte os dois. A competência é um
-- FATO do faturamento e passa a ser gravada como tal: `registrar_faturamento`
-- preenche esta coluna, e refaturar sobrescreve — porque a nota que vale é a que a
-- OV tem agora.
--
-- A dedução antiga continua como fallback, para as OVs faturadas antes desta
-- coluna existir (o backfill resolve a maioria; ver backfill_data_faturamento.py).

ALTER TABLE pedidos
    ADD COLUMN IF NOT EXISTS data_faturamento TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pedidos_data_faturamento
    ON pedidos (data_faturamento)
    WHERE data_faturamento IS NOT NULL;

COMMENT ON COLUMN pedidos.data_faturamento IS
    'Quando a NF que a OV tem HOJE foi emitida. Define a competência do '
    'faturamento. Refaturar sobrescreve. NULL = OV anterior à v31, cai no '
    'fallback pela movimentação de FATURADO.';
