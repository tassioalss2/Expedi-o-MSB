-- v21 (29/07/2026): CRM com fluxo qualificado — leads, funil com portões e
-- aprendizado de perda.
--
-- Por que refazer em vez de remendar: `crm_leads`, `crm_cotacoes`,
-- `crm_cotacao_itens` nunca chegaram ao banco (o código existia, a migration não
-- rodou), e `crm_oportunidades` tem 2 registros de teste. Então dá para desenhar
-- a estrutura certa uma vez, sem migração de dado real.
--
-- O que muda no processo (era o problema: nada era exigido para avançar):
--   1. Qualificação virou informação, não rótulo. O lead só passa a QUALIFICADO
--      com necessidade (o que compra e quanto/mês), decisor (quem assina) e
--      prazo (quando compra) preenchidos. Cada um é campo estruturado.
--   2. Score deixa de medir preenchimento de formulário e passa a medir encaixe
--      comercial + intenção, com queda por inatividade. `score_detalhe` guarda a
--      explicação componente a componente — score que ninguém entende, ninguém usa.
--   3. Toda negociação aberta tem próximo passo com data. Sem isso o card fica
--      parado e o CRM morre em três semanas.
--   4. Perda passa a ter motivo CODIFICADO (+ concorrente e preço do vencedor
--      quando se sabe). Texto livre não deixa a aba Inteligência aprender nada.
--
-- Escopo: o CRM cuida de VENDA PRIVADA. Licitação nasce e vive no módulo de
-- Licitações (pregões/empenhos/demandas) — manter os dois lugares acompanhando a
-- mesma negociação levava a números divergentes.
-- Idempotente.

-- ── Leads ───────────────────────────────────────────────────────────────────────
create table if not exists crm_leads (
  id uuid primary key default gen_random_uuid(),
  empresa text not null,
  cnpj text,
  -- Preenchido quando o lead já é cliente da base (relacionamento existente).
  cliente_id uuid references clientes(id) on delete set null,
  canal text,
  origem text,

  contato_nome text,
  email text,
  telefone text,

  -- ── Qualificação ──
  -- O que compra: {familia, codigos[], consumo_mes, unidade, observacao}
  necessidade jsonb,
  -- Quem decide: {nome, papel, email, telefone}
  -- papel: COMPRADOR | CHEFE_SERVICO | FARMACIA | DIRETOR_TECNICO | ADMINISTRADOR | OUTRO
  decisor jsonb,
  -- Quando compra: {tipo: 'DATA'|'JANELA', data, janela}
  -- janela: ATE_30D | 30_60D | 60_90D | ACIMA_90D | SEM_PREVISAO
  prazo jsonb,
  -- Verba — NÃO obrigatória para qualificar (decisão do negócio), mas quando
  -- informada pesa no score: {confirmada, valor, observacao}
  verba jsonb,

  status text not null default 'NOVO',
  -- Descarte com motivo codificado, para saber por que os leads morrem.
  motivo_descarte_codigo text,
  motivo_descarte text,

  score int not null default 0,
  temperatura text,
  score_detalhe jsonb,

  -- Higiene do funil.
  ultimo_contato_em timestamptz,
  proximo_passo text,
  proximo_passo_em date,

  oportunidade_id uuid,
  responsavel_id uuid references usuarios(id) on delete set null,
  observacao text,
  ativo boolean not null default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create index if not exists idx_crm_leads_status on crm_leads (status) where ativo;
create index if not exists idx_crm_leads_score on crm_leads (score desc) where ativo;
create index if not exists idx_crm_leads_proximo on crm_leads (proximo_passo_em) where ativo;

-- ── Cotações / propostas ────────────────────────────────────────────────────────
create table if not exists crm_cotacoes (
  id uuid primary key default gen_random_uuid(),
  numero text not null,
  cliente_id uuid references clientes(id) on delete set null,
  contato_id uuid references crm_contatos(id) on delete set null,
  oportunidade_id uuid references crm_oportunidades(id) on delete set null,
  canal text,
  status text not null default 'RASCUNHO',
  validade date,
  condicao_pagamento text,
  prazo_entrega text,
  frete numeric(14,2) default 0,
  desconto_pct numeric(6,2) default 0,
  observacao text,
  valor_bruto numeric(14,2) default 0,
  valor_total numeric(14,2) default 0,
  -- Data do envio: é o que libera o avanço para Negociação (proposta que não
  -- saiu não é negociação).
  enviada_em timestamptz,
  responsavel_id uuid references usuarios(id) on delete set null,
  ativo boolean not null default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create unique index if not exists idx_crm_cotacoes_numero on crm_cotacoes (numero);
create index if not exists idx_crm_cotacoes_oportunidade on crm_cotacoes (oportunidade_id) where ativo;

create table if not exists crm_cotacao_itens (
  id uuid primary key default gen_random_uuid(),
  cotacao_id uuid not null references crm_cotacoes(id) on delete cascade,
  produto_id uuid references produtos(id) on delete set null,
  codigo text,
  descricao text,
  qtd numeric(14,2) default 0,
  valor_unitario numeric(14,2) default 0,
  desconto_pct numeric(6,2) default 0,
  criado_em timestamptz default now()
);

create index if not exists idx_crm_cotacao_itens_cotacao on crm_cotacao_itens (cotacao_id);

-- ── Oportunidades: portões, higiene e aprendizado ───────────────────────────────
alter table crm_oportunidades
  -- Qualificação herdada do lead na conversão, para o funil não perder o
  -- "por que isso é uma oportunidade".
  add column if not exists qualificacao jsonb,
  -- Próximo passo obrigatório enquanto a oportunidade está aberta.
  add column if not exists proximo_passo text,
  add column if not exists proximo_passo_em date,
  -- Quando entrou no estágio atual — base do alerta de card parado. O
  -- `atualizado_em` não serve: qualquer edição o move.
  add column if not exists estagio_em timestamptz,
  -- Perda estruturada.
  add column if not exists motivo_perda_codigo text,
  add column if not exists concorrente text,
  add column if not exists preco_vencedor numeric(14,2),
  -- Custo estimado dos itens, para a margem da proposta ser calculada e exibida.
  add column if not exists custo_estimado numeric(14,2);

-- Estágio LEAD sai do funil: era a mesma etapa que o status do lead, duas vezes
-- em duas tabelas. Uma oportunidade só nasce depois de qualificada.
update crm_oportunidades set estagio = 'QUALIFICACAO' where estagio = 'LEAD';

-- Sem estagio_em, todo card já existente pareceria parado desde sempre.
update crm_oportunidades
   set estagio_em = coalesce(atualizado_em, criado_em, now())
 where estagio_em is null;

create index if not exists idx_crm_oport_proximo on crm_oportunidades (proximo_passo_em) where ativo;
create index if not exists idx_crm_oport_estagio_em on crm_oportunidades (estagio, estagio_em) where ativo;

comment on column crm_oportunidades.motivo_perda_codigo is
  'PRECO | PRAZO_ENTREGA | CONCORRENTE | SEM_VERBA | PRODUTO_NAO_ATENDE | SEM_RESPOSTA | TIMING | OUTRO';
comment on column crm_leads.status is
  'NOVO | EM_CONTATO | QUALIFICADO | CONVERTIDO | DESCARTADO';
comment on column crm_leads.motivo_descarte_codigo is
  'SEM_PERFIL | SEM_VERBA | SEM_RESPOSTA | JA_TEM_FORNECEDOR | PRODUTO_NAO_ATENDE | DUPLICADO | OUTRO';
