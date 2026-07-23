-- v16: Comunicado de uso passa a ser regido por AF, nome do paciente e prontuário.
-- AF reaproveita a coluna "numero" já existente em licitacao_demandas (mesmo padrão
-- de reuso usado para pregão/NE). nome_paciente e prontuario são novos.
ALTER TABLE licitacao_demandas ADD COLUMN IF NOT EXISTS nome_paciente text;
ALTER TABLE licitacao_demandas ADD COLUMN IF NOT EXISTS prontuario text;

-- No pedido gerado pelo comunicado (tabela pedidos), guarda os 3 campos para
-- rastreabilidade direta na OV/lançamento, sem precisar voltar à demanda de origem.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS af text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS nome_paciente text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS prontuario text;
