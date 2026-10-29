-- v15 (29/10/2026): a data que o CLIENTE pediu, separada da que nos prometemos.
--
-- Ja existe data_esperada_cliente (v14), mas ela nao serve para isso: o app a
-- preenche COPIANDO data_prevista_entrega na abertura da OV, e em 77% das 667
-- OVs desde agosto as duas sao identicas. Nao da para distinguir copia de dado
-- informado, nem nas 102 em que diferem — basta a entrega prevista ter sido
-- mudada depois da abertura (foi o caso da OV017357). Por isso campo novo, em
-- vez de reaproveitar um campo ja poluido: NULO aqui significa "ninguem
-- informou", e so.
--
-- Com ela a pontualidade passa a ser medida contra o que o cliente pediu, e nao
-- contra a data que nos mesmos escolhemos — que e a unica das duas que a
-- operacao nao pode ajustar para caber.
--
-- Aditiva e idempotente — pode rodar a qualquer momento.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS data_cliente date;

COMMENT ON COLUMN pedidos.data_cliente IS
  'Data de entrega pedida pelo cliente (empenho, contrato ou pedido). Informada, '
  'nunca copiada de outro campo. NULO = ninguem informou.';
