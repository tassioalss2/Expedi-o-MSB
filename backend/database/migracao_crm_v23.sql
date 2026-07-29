-- CRM v23 — endereço de entrega/faturamento na cotação.
--
-- O modelo real (proposta que a Cristiane envia por fora) traz o endereço
-- completo do cliente na capa da proposta. `clientes` não guarda endereço (é
-- cadastro simples, compartilhado com licitação/expedição) — em vez de inchar
-- aquela tabela para todo o resto do app, o endereço vira um snapshot na
-- própria cotação, do jeito que já é feito hoje: cada proposta pode ir para
-- uma unidade/endereço diferente do mesmo cliente.
-- Idempotente.

alter table crm_cotacoes
  add column if not exists endereco text,
  add column if not exists endereco_bairro text,
  add column if not exists endereco_cidade text,
  add column if not exists endereco_uf text,
  add column if not exists endereco_cep text;
