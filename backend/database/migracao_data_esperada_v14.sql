-- v14 (22/07/2026): separa a data esperada pelo cliente da data prevista de entrega.
-- Na criação da OV (licitação/CRM) captura-se a DATA ESPERADA PELO CLIENTE.
-- A DATA PREVISTA DE ENTREGA (compromisso real) é definida por Operações de
-- Vendas na cotação do frete (CIF) ou ao registrar a transportadora (FOB).
-- Aditiva e idempotente — pode rodar a qualquer momento.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS data_esperada_cliente date;
