create table if not exists crm_leads (
  id uuid primary key default gen_random_uuid(),
  empresa text not null,
  contato_nome text,
  email text,
  telefone text,
  cnpj text,
  canal text,
  origem text,
  valor_potencial numeric not null default 0,
  status text not null default 'NOVO',
  score integer not null default 0,
  temperatura text default 'FRIO',
  observacao text,
  cliente_id uuid references clientes(id),
  responsavel_id uuid references usuarios(id),
  motivo_descarte text,
  oportunidade_id uuid references crm_oportunidades(id),
  ativo boolean default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create table if not exists crm_cotacoes (
  id uuid primary key default gen_random_uuid(),
  numero text,
  cliente_id uuid references clientes(id),
  contato_id uuid references crm_contatos(id),
  oportunidade_id uuid references crm_oportunidades(id),
  canal text,
  status text not null default 'RASCUNHO',
  validade date,
  condicao_pagamento text,
  prazo_entrega text,
  frete numeric not null default 0,
  desconto_pct numeric not null default 0,
  observacao text,
  valor_bruto numeric not null default 0,
  valor_total numeric not null default 0,
  responsavel_id uuid references usuarios(id),
  enviada_em timestamptz,
  respondida_em timestamptz,
  ativo boolean default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create table if not exists crm_cotacao_itens (
  id uuid primary key default gen_random_uuid(),
  cotacao_id uuid references crm_cotacoes(id) on delete cascade,
  produto_id uuid references produtos(id),
  codigo text,
  descricao text,
  qtd numeric not null default 0,
  valor_unitario numeric not null default 0,
  desconto_pct numeric not null default 0
);

create index if not exists idx_crm_leads_status on crm_leads(status);
create index if not exists idx_crm_leads_ativo on crm_leads(ativo);
create index if not exists idx_crm_cotacoes_cliente on crm_cotacoes(cliente_id);
create index if not exists idx_crm_cotacoes_status on crm_cotacoes(status);
create index if not exists idx_crm_cotacoes_opp on crm_cotacoes(oportunidade_id);
create index if not exists idx_crm_cotacao_itens_cot on crm_cotacao_itens(cotacao_id);
