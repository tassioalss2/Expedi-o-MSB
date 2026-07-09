-- Migration v6: canal comercial da OV (área Comercial — fase 2)
-- Valores: URO, VASCULAR, REALCLOSURE, LICITACAO (nulo = sem canal)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS canal VARCHAR(20);
