-- Migration v5: meta de faturamento por mês (área Comercial)
CREATE TABLE IF NOT EXISTS metas_faturamento (
    competencia   VARCHAR(7) PRIMARY KEY,        -- 'YYYY-MM'
    valor         NUMERIC(14,2) NOT NULL,
    atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
