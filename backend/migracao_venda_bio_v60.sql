-- Venda da Bio: receita que nao e da meta da linha.
--
-- A Biomedical fecha venda direta com cliente final e a NF sai pela MSB
-- (OV017355, MEDINTERP, R$ 50.000). O produto e vascular, entao a venda caia
-- inteira na meta da Vascular — a meta de uma pessoa, que nao vendeu nada
-- disso. Nao e transfer price: o cliente nao e a Biomedical, a receita e real.
--
-- Isto NAO e a linha do produto nem a forma de venda: e QUEM vendeu. Por isso
-- coluna propria, e nao mais um valor em `canal` — `canal` e recalculado dos
-- itens a cada mexida (_sincronizar_linha) e apagaria a marcacao.
--
-- O faturamento passa a somar essas vendas num balde separado por linha
-- ("Vascular - Bio"), fora das metas de Uro/Vascular/Realclosure. Sem meta
-- definida ainda: so acompanhamento.

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS venda_bio boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pedidos.venda_bio IS
  'Venda fechada pela Biomedical (nao pelo comercial da MSB). Tira a receita '
  'da meta da linha e joga no balde "<Linha> - Bio", que e so monitorado. '
  'Nada a ver com transfer price, que se reconhece pelo nome do cliente.';
