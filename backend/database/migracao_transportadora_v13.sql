-- v13 (22/07/2026): nova etapa "Aguardando transportadora" no fluxo FOB.
-- Depois da cubagem, a OV FOB fica aguardando o cliente informar qual
-- transportadora vai coletar (a transportadora vai na NF). Só então segue
-- para faturamento. CIF continua indo para "Cotação de frete".
-- Atualiza o CHECK do status de pedidos para aceitar AGUARD_TRANSPORTADORA.
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
  'AGUARD_TRANSPORTADORA',
  'AGUARD_FATURAMENTO',
  'FATURADO',
  'AGUARD_COLETA',
  'COLETADO',
  'EXPEDIDO',
  'BLOQUEADO',
  'CANCELADO'
));
