-- v27 (30/07/2026): nova etapa "Dados da OV" — venda ganha no CRM cai direto
-- no kanban da Expedição, antes mesmo de existir número real da OV (D365).
--
-- Cliente e valor já são conhecidos (vêm da oportunidade); falta só o número
-- real e a data de entrega, que a operadora completa direto no card. Sem essa
-- etapa, ganhar no CRM continuava dependendo de alguém abrir o painel Repasse
-- e digitar os dados numa tela separada antes de a OV existir na Expedição.
--
-- Atualiza o CHECK do status de pedidos para aceitar AGUARD_DADOS_OV.
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_status_check;
ALTER TABLE pedidos ADD CONSTRAINT pedidos_status_check CHECK (status IN (
  'AGUARD_DADOS_OV',
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
