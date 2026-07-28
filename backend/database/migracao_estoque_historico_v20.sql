-- v20 (28/07/2026): histórico mensal de vendas do PCP no espelho diário.
--
-- A tendência e o histórico por item vinham das OVs do nosso app, que só tem
-- dados desde 29/05/2026 — pouco para comparar período e nada para os meses
-- anteriores. O app do PCP já tem 6 meses fechados vindos do D365, em
-- `pa_products.sales_history` ({"2026-01": 219, "2026-03": 59, ...}).
--
-- Guardar junto com a foto do dia (em vez de consultar o PCP a cada leitura)
-- mantém a tela funcionando se o app deles cair, e é o mesmo princípio das
-- outras colunas: a foto é imutável e substituída na sincronização seguinte.
--
-- O mês CORRENTE não vem aqui: o PCP importa mês fechado (em 28/07 o último
-- disponível era 06/2026). O acumulado do mês em curso é calculado das OVs
-- faturadas do nosso app, que é a fonte que sabe o que aconteceu hoje.
-- Idempotente.
alter table estoque_pcp_snapshot
  add column if not exists sales_history jsonb;

comment on column estoque_pcp_snapshot.sales_history is
  'Vendido por mês fechado, do D365 via pa_products.sales_history do PCP. Chave "AAAA-MM" -> quantidade. Não inclui o mês corrente.';
