create table if not exists empenhos (
  id uuid primary key default gen_random_uuid(),
  numero text not null,
  cliente_id uuid references clientes(id),
  canal text,
  data_empenho date,
  vigencia date,
  observacao text,
  ativo boolean default true,
  criado_em timestamptz default now()
);

create table if not exists empenho_itens (
  id uuid primary key default gen_random_uuid(),
  empenho_id uuid references empenhos(id) on delete cascade,
  produto_id uuid references produtos(id),
  codigo text,
  descricao text,
  qtd_empenhada numeric not null default 0,
  valor_unitario numeric not null default 0
);

alter table empenhos add column if not exists canal text;
alter table pedidos add column if not exists empenho_id uuid references empenhos(id);

create index if not exists idx_pedidos_empenho on pedidos(empenho_id);
create index if not exists idx_empenho_itens_empenho on empenho_itens(empenho_id);
