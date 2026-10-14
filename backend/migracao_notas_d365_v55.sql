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
  -- LICITACAO ou COMERCIAL, decidido pela propria operacao fiscal:
  -- "destinada a nao contribuinte" e venda direta de licitacao e
  -- "remetida anteriormente em consignacao" e comunicado de uso; o resto e
  -- venda normal, que nao e licitacao.
  origem_venda     text,
  -- Linha comercial da nota. Nota com OV nao usa esta coluna (a OV manda, item
  -- a item). Nota SEM OV nasce em VASCULAR quando e de licitacao, porque e la
  -- que praticamente toda licitacao cai, e pode ser corrigida a mao na tela.
  linha            text,
  linha_ajustada   boolean not null default false,
  chave_acesso     text,

  -- A OV do app que corresponde a esta nota, quando existe. Nulo = nota que
  -- nasceu fora do app (o comunicado de uso da Bio, por exemplo).
  pedido_id        uuid references public.pedidos(id) on delete set null,

  arquivo          text,
  importado_em     timestamptz not null default now(),
  importado_por    uuid references public.usuarios(id),

  -- Quem emitiu: "Estabelecimento fiscal" (nota nossa) ou "Terceiro" (nota do
  -- fornecedor, que entra no livro como compra). Só a nossa é faturamento.
  emissor          text,
  -- A nota, sem o status: direcao|numero|serie|cnpj. É por aqui que uma
  -- reimportação apaga a versão antiga — se a chave levasse o status, a nota
  -- que foi cancelada depois ficaria duas vezes, uma aprovada e uma cancelada.
  chave_nota       text,
  -- A linha exata do livro, com o status. Duas linhas da mesma nota existem de
  -- verdade (o frete 34469 veio Aprovado 440,23 e Revertido 792,50), e o número
  -- sozinho não serve de identidade: a nota de entrada é numerada pelo
  -- FORNECEDOR, então dois fornecedores têm a nota 1234.
  identidade       text
);

create unique index if not exists idx_notas_d365_identidade
  on public.notas_d365 (identidade);
create index if not exists idx_notas_d365_chave_nota on public.notas_d365 (chave_nota);

create index if not exists idx_notas_d365_data    on public.notas_d365 (data_documento);
create index if not exists idx_notas_d365_chave   on public.notas_d365 (chave_numero);
create index if not exists idx_notas_d365_pedido  on public.notas_d365 (pedido_id);
create index if not exists idx_notas_d365_tipo    on public.notas_d365 (tipo_operacao);
