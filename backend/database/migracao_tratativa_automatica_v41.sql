-- v41 · "Em tratamento" deduzido da conversa, sem apagar quem decidiu à mão
--
-- Pedido do Tássio: se alguém de nós já respondeu o e-mail, o caso está em
-- tratamento — e a tela deve dizer o nome de quem respondeu. O sinal já existe
-- desde a v39 (`respondido_em` / `respondido_por`, a última fala de alguém da
-- MSB na conversa; a caixa da licitação não conta, porque ela repassa e sai).
-- Medido em 08/09/2026: 112 de 192 conversas têm resposta nossa.
--
-- O problema de fazer isso ingenuamente: `em_tratativa` é um booleano com
-- default `false`, então "ninguém mexeu" e "alguém liberou de propósito" são o
-- MESMO valor no banco. Se a dedução simplesmente somasse ao booleano, um caso
-- que alguém liberou voltaria a aparecer como "em tratamento" por causa de uma
-- resposta antiga — a máquina desfazendo a decisão de uma pessoa, que é o que
-- este módulo inteiro existe para não fazer.
--
-- Daí esta coluna: três estados de verdade.
--
--     NULL   ninguém mexeu     -> vale a dedução da conversa
--     true   alguém assumiu    -> em tratamento, e o nome é de quem assumiu
--     false  alguém liberou    -> NÃO tratado, mesmo que exista resposta nossa
ALTER TABLE licitacao_entrada
    ADD COLUMN IF NOT EXISTS tratativa_manual boolean;

-- Quem está marcado hoje foi marcado por gente, clicando em "assumir": essa
-- decisão precisa continuar valendo depois da mudança.
UPDATE licitacao_entrada
   SET tratativa_manual = true
 WHERE em_tratativa IS TRUE AND tratativa_manual IS NULL;

COMMENT ON COLUMN licitacao_entrada.tratativa_manual IS
    'Decisão humana sobre "em tratamento": NULL = ninguém mexeu (vale a dedução '
    'pela resposta na conversa), true = assumiu, false = liberou de propósito. '
    'A sincronização NUNCA escreve nesta coluna.';
COMMENT ON COLUMN licitacao_entrada.em_tratativa IS
    'OBSOLETA como fonte de verdade desde a v41 — quem manda é tratativa_manual, '
    'e na ausência dela a resposta nossa na conversa (respondido_em). Mantida '
    'porque é o registro do que existia antes.';
