create table if not exists crm_contatos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cargo text,
  email text,
  telefone text,
  cliente_id uuid references clientes(id),
  canal text,
  observacao text,
  ativo boolean default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create table if not exists crm_oportunidades (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  cliente_id uuid references clientes(id),
  contato_id uuid references crm_contatos(id),
  canal text,
  estagio text not null default 'LEAD',
  valor_estimado numeric not null default 0,
  probabilidade integer not null default 10,
  origem text,
  previsao_fechamento date,
  responsavel_id uuid references usuarios(id),
  motivo_perda text,
  ganho_em timestamptz,
  perdido_em timestamptz,
  gerado_ov_id uuid references pedidos(id),
  gerado_ov_ref text,
  ativo boolean default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create table if not exists crm_oportunidade_itens (
  id uuid primary key default gen_random_uuid(),
  oportunidade_id uuid references crm_oportunidades(id) on delete cascade,
  produto_id uuid references produtos(id),
  codigo text,
  descricao text,
  qtd numeric not null default 0,
  valor_unitario numeric not null default 0
);

create table if not exists crm_atividades (
  id uuid primary key default gen_random_uuid(),
  oportunidade_id uuid references crm_oportunidades(id) on delete cascade,
  contato_id uuid references crm_contatos(id),
  cliente_id uuid references clientes(id),
  tipo text not null default 'TAREFA',
  titulo text not null,
  descricao text,
  data_hora timestamptz,
  concluida boolean default false,
  concluida_em timestamptz,
  responsavel_id uuid references usuarios(id),
  criado_em timestamptz default now()
);

create table if not exists crm_notas (
  id uuid primary key default gen_random_uuid(),
  oportunidade_id uuid references crm_oportunidades(id) on delete cascade,
  tipo text not null default 'NOTA',
  texto text not null,
  autor_id uuid references usuarios(id),
  criado_em timestamptz default now()
);

create index if not exists idx_crm_contatos_cliente on crm_contatos(cliente_id);
create index if not exists idx_crm_opp_estagio on crm_oportunidades(estagio);
create index if not exists idx_crm_opp_cliente on crm_oportunidades(cliente_id);
create index if not exists idx_crm_opp_ativo on crm_oportunidades(ativo);
create index if not exists idx_crm_opp_itens_opp on crm_oportunidade_itens(oportunidade_id);
create index if not exists idx_crm_atividades_opp on crm_atividades(oportunidade_id);
create index if not exists idx_crm_atividades_concluida on crm_atividades(concluida);
create index if not exists idx_crm_notas_opp on crm_notas(oportunidade_id);
