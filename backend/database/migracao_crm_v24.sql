-- CRM v24 — os campos do orçamento que o cadastro não tem.
--
-- O modelo real traz CNPJ do cliente, nome e e-mail de quem recebe. Nenhum dos
-- três é garantido: `clientes` é cadastro enxuto (o CNPJ costuma estar vazio) e
-- muita proposta sai antes de existir contato cadastrado. Em vez de tornar
-- obrigatório (o que travaria o vendedor) ou de deixar em branco no PDF (o que
-- aconteceu), cada um vira um campo da própria cotação: preenchido a partir do
-- cadastro quando existe lá, digitado na hora quando não existe.
-- Idempotente.

alter table crm_cotacoes
  -- Sobrepõe/complementa clientes.cnpj — a proposta é o documento, precisa do
  -- número certo mesmo que o cadastro esteja incompleto.
  add column if not exists cliente_cnpj text,
  -- Destinatário quando não há contato_id cadastrado.
  add column if not exists contato_nome text,
  add column if not exists contato_email text;
