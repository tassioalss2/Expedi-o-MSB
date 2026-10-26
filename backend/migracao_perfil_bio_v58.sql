-- Perfil BIO: a Biomedical passa a lancar pedido para a MSB e a acompanhar a
-- entrega. Ve o kanban da expedicao e o rastreio — nada de faturamento,
-- margem, CRM, licitacao ou indicadores.
--
-- Rodar no SQL Editor do Supabase ANTES de criar os usuarios: o CHECK atual
-- recusa qualquer perfil fora da lista, e o insert falharia.

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;

ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check
  CHECK (perfil IN ('LOGISTICA', 'OPERACOES_VENDAS', 'COMERCIAL', 'DIRETORIA',
                    'ADMIN', 'CONSELHO', 'BIO'));
