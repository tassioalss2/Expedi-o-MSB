-- v11 (21/07/2026): nova etapa "Aguardando cotação de frete" no fluxo operacional.
-- Só OVs CIF (com/sem valor) param nela após a cubagem; FOB vai direto pra faturamento.
-- Atualiza o CHECK do status de pedidos para aceitar EM_COTACAO_FRETE.
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_status_check;
ALTER TABLE pedidos ADD CONSTRAINT pedidos_status_check CHECK (status IN (
  'AGUARD_CREDITO',
  'LIBERADO',
  'EM_INVENTARIO',
  'AGUARD_VERIFICACAO',
  'DIVERGENCIA',
  'AGUARD_TRATATIVA',
  'EM_PROCESSO_SISTEMICO',
  'EM_COTACAO_FRETE',
  'AGUARD_FATURAMENTO',
  'FATURADO',
  'AGUARD_COLETA',
  'COLETADO',
  'EXPEDIDO',
  'BLOQUEADO',
  'CANCELADO'
));
