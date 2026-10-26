-- Troca de senha no primeiro acesso.
--
-- A senha provisoria e a mesma para todo o grupo que entra junto, entao ela
-- circula por WhatsApp e e-mail ate todo mundo entrar. A marca abaixo faz o
-- app exigir uma senha nova antes de deixar usar: a provisoria vale uma vez.
--
-- Rodar no SQL Editor do Supabase.

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS trocar_senha boolean NOT NULL DEFAULT false;

-- Quem ja usa o app nao e afetado: so quem for marcado daqui para a frente.
