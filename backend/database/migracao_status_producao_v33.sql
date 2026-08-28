-- v33 (28/08/2026): pedidos.status passa a aceitar AGUARD_PRODUCAO.
--
-- PRÉ-REQUISITO CRÍTICO — sem ela, "Jogar tudo na pendência" falha.
--
-- O status AGUARD_PRODUCAO existe no enum StatusPedido desde a venda outbound
-- ("aguardar a produção": a venda é registrada, nenhum item desce para a
-- expedição e tudo fica na pendência), mas NUNCA entrou no CHECK da coluna. O
-- caminho nunca tinha sido exercido de verdade — nenhum pedido do banco jamais
-- teve esse status — então a falha só apareceu agora, quando "Jogar tudo na
-- pendência" passou a ser oferecido também na Nova OV (commit f9dbec5).
--
-- Sintoma: 400 do PostgREST, code 23514,
--   'new row for relation "pedidos" violates check constraint "pedidos_status_check"'
-- que a tela mostrava como "Erro ao lançar a venda".
--
-- Recria o CHECK com a lista COMPLETA do enum, não só com o que faltava: v11 e
-- v13 já tiveram que fazer isso uma vez cada, e a constraint tinha ficado três
-- valores atrás do código (AGUARD_DADOS_OV, AGUARD_TRANSPORTADORA e este).
-- Conferir contra app/models/enums.py ao adicionar status novo.
--
-- Idempotente: pode rodar mais de uma vez.

ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_status_check;
ALTER TABLE pedidos ADD CONSTRAINT pedidos_status_check CHECK (status IN (
  'AGUARD_DADOS_OV',
  'AGUARD_PRODUCAO',
  'AGUARD_CREDITO',
  'LIBERADO',
  'EM_INVENTARIO',
  'AGUARD_VERIFICACAO',
  'DIVERGENCIA',
  'AGUARD_TRATATIVA',
  'EM_PROCESSO_SISTEMICO',
  'EM_COTACAO_FRETE',
  'AGUARD_TRANSPORTADORA',
  'AGUARD_FATURAMENTO',
  'FATURADO',
  'AGUARD_COLETA',
  'COLETADO',
  'EXPEDIDO',
  'BLOQUEADO',
  'CANCELADO'
));
