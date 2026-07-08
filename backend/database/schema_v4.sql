-- Migration v4: natureza da operação da OV
-- Só VENDA_NORMAL e COMUNICADO_USO contam como faturamento.
-- As demais (bonificação, amostra, consignado) geram NF e passam pelo fluxo,
-- mas não são faturamento (apenas movimentam estoque).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo_operacao VARCHAR(20) DEFAULT 'VENDA_NORMAL';

-- Garante que registros existentes fiquem como venda normal.
UPDATE pedidos SET tipo_operacao = 'VENDA_NORMAL' WHERE tipo_operacao IS NULL;
