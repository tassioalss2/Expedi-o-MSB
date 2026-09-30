-- v53 — Venda parada por decisão do cliente
--
-- Caso real: a OV017010 (WC HOSPITALAR, 30 un de 56010) voltou para a pendência
-- porque o cliente está devendo, tem que pagar à vista e só paga no mês que vem.
-- O material EXISTE — havia 105 un disponíveis. Mesmo assim o card dizia
-- "Aguardando produção" e o cronômetro marcava 220h acima do SLA de 2h, como se
-- a demora fosse nossa.
--
-- O motivo ficava só no texto de uma movimentação, então nem a tela sabia dele.
-- Aqui ele vira campo: dá para tirar do kanban, parar o relógio e dizer por quê.
--
-- Colunas e não uma linha em `pendencia` (jsonb) de propósito: aquele campo é
-- reescrito inteiro por vários fluxos, e uma chave extra sumiria em silêncio no
-- primeiro deles.

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS espera_tipo   TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS espera_motivo TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS espera_desde  TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS espera_por    UUID;

COMMENT ON COLUMN pedidos.espera_tipo IS
  'Por que a venda esta parada por decisao externa, nao por falta nossa. '
  'Hoje so CLIENTE (cliente adiou, esta inadimplente ou desistiu por ora). '
  'NULL = venda andando normalmente.';
COMMENT ON COLUMN pedidos.espera_motivo IS
  'O que a pessoa escreveu ao parar a venda. Obrigatorio ao marcar.';
COMMENT ON COLUMN pedidos.espera_desde IS
  'Quando parou. O relogio de SLA para aqui — a espera nao e nossa.';

-- Busca as paradas sem varrer a tabela: o kanban pergunta por elas toda vez.
CREATE INDEX IF NOT EXISTS idx_pedidos_espera
  ON pedidos (espera_tipo) WHERE espera_tipo IS NOT NULL;
