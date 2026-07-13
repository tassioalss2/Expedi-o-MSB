-- Migração: 5 perfis de acesso (LOGISTICA, OPERACOES_VENDAS, COMERCIAL, DIRETORIA, ADMIN)
-- Rodar no SQL Editor do Supabase. Os usuários atuais são ADMIN, então nada é invalidado.

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;

ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check
  CHECK (perfil IN ('LOGISTICA', 'OPERACOES_VENDAS', 'COMERCIAL', 'DIRETORIA', 'ADMIN'));
