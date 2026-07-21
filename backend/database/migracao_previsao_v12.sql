-- v12 (21/07/2026): Previsão de Faturamento.
-- Entrada rápida dedicada para o comercial lançar negócios em negociação
-- (o que falta só fechar) — alimenta a previsão do mês/dia junto ao que já
-- está em processo (OVs) e ao saldo de contratos ganhos.
create table if not exists previsao_negocios (
  id                  uuid primary key default gen_random_uuid(),
  cliente_id          uuid references clientes(id),
  cliente_nome        text,                 -- nome livre (não exige cadastro)
  descricao           text,
  valor               numeric not null default 0,
  probabilidade       int not null default 50,   -- 0..100 (chance de fechar)
  previsao_fechamento date,                  -- data provável do fechamento
  canal               text,
  status              text not null default 'ABERTO'
                        check (status in ('ABERTO','GANHO','PERDIDO')),
  observacao          text,
  responsavel_id      uuid references usuarios(id),
  ganho_em            timestamptz,
  perdido_em          timestamptz,
  ativo               boolean not null default true,
  criado_em           timestamptz default now(),
  atualizado_em       timestamptz default now()
);

create index if not exists idx_previsao_status
  on previsao_negocios (status) where ativo;
create index if not exists idx_previsao_fechamento
  on previsao_negocios (previsao_fechamento) where ativo;
