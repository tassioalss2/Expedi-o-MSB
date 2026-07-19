create table if not exists app_estado (
  chave text primary key,
  valor text,
  atualizado_em timestamptz default now()
);
