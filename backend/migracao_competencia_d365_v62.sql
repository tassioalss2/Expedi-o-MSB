-- v62 — A competência da nota é a data de LANÇAMENTO.
--
-- O espelho filtrava o mês pela data do DOCUMENTO. Estava errado: o mês fecha
-- pela contabilidade, e o que entra nela é o lançamento. A devolução da
-- Infinity (NF 000021254) mostrou a diferença — documento de 19/10, lançamento
-- em 04/11. Pela data do documento ela abatia outubro; o estorno aconteceu em
-- novembro, e é novembro que tem de senti-lo. (Regra confirmada pelo Tássio em
-- 06/11/2026.)
--
-- No export de 19/10 a 06/11, 13 das 80 notas trocam de mês por essa regra.
-- Doze são COMPRA, que não entram em faturamento nenhum; a décima terceira é
-- justamente a devolução da Infinity. Nenhuma VENDA muda de mês.
--
-- Coluna gerada em vez de UPDATE: ela não pode envelhecer. Nota importada
-- amanhã por um export sem a coluna de lançamento continua valendo pela data
-- do documento, sem ninguém ter de lembrar de preencher nada.

ALTER TABLE notas_d365
    ADD COLUMN IF NOT EXISTS data_competencia DATE
    GENERATED ALWAYS AS (COALESCE(data_lancamento, data_documento)) STORED;

CREATE INDEX IF NOT EXISTS idx_notas_d365_competencia
    ON notas_d365(data_competencia);

COMMENT ON COLUMN notas_d365.data_competencia IS
    'Mes a que a nota pertence: data de lancamento, ou a do documento quando o '
    'export nao trouxe lancamento. E por esta coluna que o periodo e filtrado.';
