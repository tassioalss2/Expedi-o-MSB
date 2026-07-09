-- Migration v7: metas de faturamento por canal
-- Antes: 1 meta por mês (PK competencia). Agora: 1 meta por (competencia, canal).
-- A meta total do mês = soma das metas dos canais.
ALTER TABLE metas_faturamento ADD COLUMN IF NOT EXISTS canal VARCHAR(20) NOT NULL DEFAULT 'GERAL';
ALTER TABLE metas_faturamento DROP CONSTRAINT IF EXISTS metas_faturamento_pkey;
ALTER TABLE metas_faturamento ADD PRIMARY KEY (competencia, canal);
