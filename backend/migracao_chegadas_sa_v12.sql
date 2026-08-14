-- Chegadas de semiacabado: o registro de que um item VIROU acabado durante o dia.
--
-- O PCP publica ao vivo, então quem descobre a chegada é a própria sincronização:
-- ao comparar a foto nova com a anterior, um item que perdeu SA e ganhou PA
-- acabou de chegar ao estoque. Esta tabela guarda esse evento.
--
-- É um LOG (append-only), não um saldo. O estoque continua vindo da foto do PCP —
-- aqui fica só a memória do que mudou e quando, que é o que a tela precisa para
-- avisar "chegou agora" e o que a auditoria precisa para reconstruir o dia.
create table if not exists estoque_chegadas_sa (
  id           uuid primary key default gen_random_uuid(),
  data_ref     date not null,
  codigo       text not null,
  descricao    text,
  qtd          numeric not null,          -- quanto entrou no acabado
  pa_antes     numeric,
  pa_depois    numeric,
  sa_antes     numeric,
  sa_depois    numeric,
  detectado_em timestamptz not null default now()
);

create index if not exists idx_chegadas_sa_data on estoque_chegadas_sa (data_ref);
create index if not exists idx_chegadas_sa_codigo on estoque_chegadas_sa (data_ref, codigo);
