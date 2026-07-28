-- v19 (28/07/2026): espelho diário do estoque do PCP.
--
-- O PCP atualiza o estoque toda manhã (planilha exportada do D365 -> app deles).
-- Aqui a gente guarda essa FOTO e, no decorrer do dia, calcula o disponível
-- descontando as OVs em aberto do nosso app.
--
-- Por que guardar a foto em vez de um saldo que vai sendo decrementado:
-- um saldo mutável acumula desvio (retry, OV corrigida, bug) e não dá para
-- auditar. Com a foto imutável + desconto calculado na leitura, o número se
-- autocorrige: a sincronização da manhã substitui a base, e o comprometido é
-- sempre recalculado a partir das OVs reais.
--
-- Isso também resolve as baixas que só o PCP conhece (ajuste de inventário,
-- bloqueio de estoque, chegada de produção): elas entram sozinhas na foto
-- seguinte, sem o nosso app tentar adivinhar.
--
-- Uma linha por produto por dia (data_ref), então dá para comparar dias e
-- entender o que mudou. Idempotente.
create table if not exists estoque_pcp_snapshot (
  id uuid primary key default gen_random_uuid(),
  -- Dia a que a foto se refere (fuso BRT). Junto com o codigo, é a chave.
  data_ref date not null,
  codigo text not null,
  descricao text,
  familia text,
  -- Números vindos da view pa_coverage do PCP, como recebidos.
  estoque_pa numeric(14,2) not null default 0,
  estoque_sa numeric(14,2) not null default 0,
  estoque_total numeric(14,2) not null default 0,
  consumo_medio numeric(14,2) not null default 0,
  -- null = sem venda nos últimos 6 meses (regra do PCP).
  cobertura_meses numeric(14,2),
  -- Momento exato da sincronização: o cálculo do comprometido usa isto para
  -- saber quais OVs faturaram DEPOIS da foto (estavam nela e já saíram).
  sincronizado_em timestamptz not null default now(),
  criado_em timestamptz default now(),
  unique (data_ref, codigo)
);

create index if not exists idx_estoque_pcp_snapshot_data on estoque_pcp_snapshot (data_ref);
create index if not exists idx_estoque_pcp_snapshot_codigo on estoque_pcp_snapshot (codigo);
