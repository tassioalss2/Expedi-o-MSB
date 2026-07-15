create table if not exists licitacao_demandas (
  id uuid primary key default gen_random_uuid(),
  tipo_operacao text not null,
  etapa text not null default 'NOVO',
  numero text,
  cliente_id uuid references clientes(id),
  canal text,
  prazo date,
  prioridade text default 'NORMAL',
  observacao text,
  responsavel_id uuid references usuarios(id),
  itens jsonb default '[]'::jsonb,
  gerado_tipo text,
  gerado_id uuid,
  gerado_ref text,
  ativo boolean default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now(),
  concluido_em timestamptz
);

create index if not exists idx_lic_demandas_etapa on licitacao_demandas(etapa);
create index if not exists idx_lic_demandas_tipo on licitacao_demandas(tipo_operacao);
create index if not exists idx_lic_demandas_ativo on licitacao_demandas(ativo);
