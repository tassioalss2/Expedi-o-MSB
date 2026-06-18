-- Migration v3: código de rastreio Correios
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS codigo_rastreio VARCHAR(50);
