-- v26 (30/07/2026): histórico de faturamento ITEM A ITEM, com custo.
--
-- POR QUE: a Inteligência só tinha 2 meses de dado próprio (o app começou a
-- registrar NF em 29/05/2026) e nenhuma noção de custo — então não sabia
-- responder margem, segmento de cliente nem sazonalidade. A `faturamento_historico`
-- (v18) tem 19 meses, mas só o valor diário total: sem cliente, sem produto.
--
-- Estas duas tabelas vêm de dois exports do D365 que a empresa já tem:
--
--   faturamento_2025_2026.xlsx  → 5.635 linhas, 19 meses (01/2025 a 07/2026),
--     R$ 31.727.088,06. Cada linha é um item de fatura com cliente, tipo de
--     cliente, UF, cidade, vertical, família, produto, qtd e receita. O export
--     já sai com o filtro "UNIDADE_DE_NEGOCIO não é INTERCOMPANY", ou seja o
--     transfer price (Biomedical) fica de fora na origem — confirmado: nenhuma
--     linha da planilha tem Biomedical.
--
--   historico_faturamento.xlsx  → movimentações de estoque por OV, com
--     "Valor de custo físico". Dá custo unitário para 128 dos 132 produtos
--     faturados (97%), e é o que finalmente permite calcular MARGEM.
--
-- Não substitui `faturamento_historico` (v18), que continua sendo a fonte do
-- realizado diário na Previsão. Esta é a base analítica, granular.
-- Idempotente.

create table if not exists faturamento_itens (
  id uuid primary key default gen_random_uuid(),

  competencia text not null,          -- 'YYYY-MM' (coluna Ano/Mês do export)
  data_faturamento date,
  numero_fatura text,

  cliente_codigo text,
  cliente_nome text not null,
  -- DISTRIBUIDOR | ORGAO_PUBLICO | VENDA_DIRETA — a segmentação que a tabela
  -- `clientes` nunca teve (lá não há tipo, UF nem CNPJ preenchido).
  cliente_tipo text,
  uf text,
  cidade text,

  -- Vertical de venda do D365 (UROLOGIA | PI & CI | GENERAL SALES).
  vertical text,
  familia text,
  produto_codigo text not null,
  produto_descricao text,

  qtd numeric(14,2) not null default 0,
  receita numeric(14,2) not null default 0,
  -- ASP do export (receita ÷ qtd). Guardado como veio, para conferência.
  preco_medio numeric(14,4),

  -- Custo aplicado a partir de produto_custo no momento da carga. Materializado
  -- de propósito: assim a margem histórica não muda quando o custo médio do
  -- produto for atualizado numa carga futura.
  custo_unitario numeric(14,4),
  custo_total numeric(14,2),

  importado_em timestamptz default now()
);

-- A carga é por competência (mês): reimportar um mês apaga e regrava só ele.
create index if not exists idx_fat_itens_competencia on faturamento_itens (competencia);
create index if not exists idx_fat_itens_cliente on faturamento_itens (cliente_nome);
create index if not exists idx_fat_itens_produto on faturamento_itens (produto_codigo);
create index if not exists idx_fat_itens_tipo on faturamento_itens (cliente_tipo);
create index if not exists idx_fat_itens_uf on faturamento_itens (uf);

comment on table faturamento_itens is
  'Faturamento item a item do D365 (export faturamento_2025_2026). Já exclui INTERCOMPANY/transfer price na origem.';
comment on column faturamento_itens.custo_unitario is
  'Custo unitário vigente na carga, vindo de produto_custo. Materializado para a margem histórica não mudar retroativamente.';

-- ── Custo médio por produto ─────────────────────────────────────────────────────
-- Média do "Valor de custo físico" ÷ quantidade nas saídas marcadas como Vendido.
-- É custo médio, não custo do lote da venda específica: o export de custo é por
-- OV e o de faturamento é por fatura, e os dois não compartilham chave. Para
-- margem por cliente/produto/segmento a média resolve; para custo exato de uma
-- NF específica, não serve — está anotado aqui para ninguém confundir depois.
create table if not exists produto_custo (
  produto_codigo text primary key,
  custo_unitario numeric(14,4) not null,
  amostras int not null default 0,
  custo_min numeric(14,4),
  custo_max numeric(14,4),
  atualizado_em timestamptz default now()
);

comment on table produto_custo is
  'Custo unitário médio por produto, das saídas Vendido do export historico_faturamento (D365).';
