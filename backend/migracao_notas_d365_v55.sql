-- v55 — Espelho das notas fiscais do D365.
--
-- Por que existe: o faturamento do app é derivado da operação (uma OV do kanban
-- recebe NF e vira faturamento). Quando a licitação passar para a Bio, o
-- comunicado de uso deixa de passar pelo app — e um número derivado da operação
-- fica curto. Aqui mora o que o D365 realmente emitiu, independente de quem
-- operou. O kanban continua sendo a operação; o faturamento passa a ser isto.
--
-- Uma linha por NF (o export do D365 é por nota, não por item). A identidade é
-- número + série + estabelecimento: reimportar o mesmo mês não duplica nada.

create table if not exists public.notas_d365 (
  id               uuid primary key default gen_random_uuid(),

  numero           text not null,
  serie            text,
  estabelecimento  text,
  -- Só os dígitos, sem zeros à esquerda. O D365 exporta 000021124 e o app
  -- guarda 21124 — é por esta coluna que as duas pontas se encontram.
  chave_numero     text not null,

  modelo           text,
  finalidade       text,
  status           text,
  direcao          text,

  cliente_conta    text,
  cliente_nome     text,
  cnpj             text,
  cliente_id       uuid references public.clientes(id),

  data_documento   date,
  data_lancamento  date,

  valor_total      numeric(14,2),
  valor_produtos   numeric(14,2),

  -- Texto original do D365 e a tradução para o vocabulário do app
  -- (VENDA_NORMAL, COMUNICADO_USO, …). Operação desconhecida fica com
  -- tipo_operacao nulo, para a tela pedir a classificação em vez de chutar.
  operacao         text,
  tipo_operacao    text,
  chave_acesso     text,

  -- A OV do app que corresponde a esta nota, quando existe. Nulo = nota que
  -- nasceu fora do app (o comunicado de uso da Bio, por exemplo).
  pedido_id        uuid references public.pedidos(id) on delete set null,

  arquivo          text,
  importado_em     timestamptz not null default now(),
  importado_por    uuid references public.usuarios(id),

  constraint notas_d365_identidade unique (numero, serie, estabelecimento)
);

create index if not exists idx_notas_d365_data    on public.notas_d365 (data_documento);
create index if not exists idx_notas_d365_chave   on public.notas_d365 (chave_numero);
create index if not exists idx_notas_d365_pedido  on public.notas_d365 (pedido_id);
create index if not exists idx_notas_d365_tipo    on public.notas_d365 (tipo_operacao);
