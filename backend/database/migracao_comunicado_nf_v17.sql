-- v17: Comunicado de uso passa a capturar NF e data do procedimento já na
-- triagem (não só ao concluir), e o valor vai por item. O prazo/vigência deixa
-- de ser pedido para este tipo (não faz sentido para comunicado).
ALTER TABLE licitacao_demandas ADD COLUMN IF NOT EXISTS numero_nf text;
ALTER TABLE licitacao_demandas ADD COLUMN IF NOT EXISTS data_procedimento date;

-- pedidos.numero_nf já existe (schema.sql); falta só a data do procedimento,
-- para rastreabilidade direta na OV/lançamento gerado pelo comunicado.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS data_procedimento date;
