-- v28 — Linha comercial no cadastro do produto
--
-- Até aqui a linha (Uro / Vascular / Realclosure) era deduzida da família por
-- dois mapas HARDCODED em Python, que divergiam entre si:
--   - estoque_service._FAMILIA_LINHA  -> "Urologia"/"Vascular" (juntava Realclosure em Vascular)
--   - inteligencia_service.FAMILIA_LINHA -> URO/VASCULAR/REALCLOSURE
-- Resultado: 12 SKUs ficavam fora das análises por linha da Inteligência, e
-- cada família nova exigia alterar código para aparecer classificada.
--
-- Agora a linha passa a ser um campo do produto, editável em Cadastros.
-- O mapa por família continua existindo em app/services/linha_produto.py, mas
-- só como fallback para código sem cadastro (ex.: itens do histórico de
-- faturamento do D365 que nunca entraram na tabela produtos).

ALTER TABLE produtos
    ADD COLUMN IF NOT EXISTS linha TEXT;

ALTER TABLE produtos
    DROP CONSTRAINT IF EXISTS produtos_linha_check;

ALTER TABLE produtos
    ADD CONSTRAINT produtos_linha_check
    CHECK (linha IS NULL OR linha IN ('URO', 'VASCULAR', 'REALCLOSURE'));

CREATE INDEX IF NOT EXISTS idx_produtos_linha ON produtos (linha);

COMMENT ON COLUMN produtos.linha IS
    'Linha comercial do produto: URO, VASCULAR ou REALCLOSURE. Fonte da verdade '
    'para os agrupamentos por linha (estoque e inteligência). Nulo cai no '
    'fallback por família em app/services/linha_produto.py.';
