-- ============================================================
-- Cria pallets pré-definidos por transportadora
-- Cole no SQL Editor do Supabase e execute
-- ============================================================

-- Garante que as transportadoras existam
INSERT INTO transportadoras (nome, sla_horas, ativo)
VALUES
  ('BRIX', 48, true),
  ('RR CARGO', 48, true),
  ('CORREIOS', 72, true),
  ('OUTROS', 96, true)
ON CONFLICT DO NOTHING;

-- Cria os pallets fixos vinculados às transportadoras
INSERT INTO pallets (codigo, transportadora_id, status)
SELECT
  'PLT-' || nome,
  id,
  'ABERTO'
FROM transportadoras
WHERE nome IN ('BRIX', 'RR CARGO', 'CORREIOS', 'OUTROS')
ON CONFLICT (codigo) DO NOTHING;

-- Verifica resultado
SELECT p.codigo, t.nome, p.status
FROM pallets p
LEFT JOIN transportadoras t ON p.transportadora_id = t.id
WHERE p.codigo LIKE 'PLT-%'
ORDER BY p.codigo;
