-- CRM v25 — repasse do ganho para operações de vendas.
--
-- O PROBLEMA: entre "comercial ganhou" e "OV existe no app" há um passo humano
-- que o app não conhecia. Operações de vendas precisa gerar a OV no D365 e só
-- depois cadastrá-la aqui — e o aviso disso viajava por mensagem de Teams ou
-- e-mail, fora do sistema. Consequência: oportunidade ganha sem OV era
-- invisível (não entrava em pendências, nem no resumo, nem em fila nenhuma) e o
-- comercial não tinha como saber se alguém já pegou o pedido.
--
-- COMO FOI MODELADO: seguindo o padrão da licitação (`licitacao_demandas.etapa`),
-- a fila é um CAMPO na tabela de origem, não uma tabela de fila separada. O
-- estado base já era derivável (`estagio = GANHO` e `gerado_ov_id` nulo); o que
-- não era derivável — e é justamente o que a mensagem de Teams comunicava — é
-- se alguém ASSUMIU o repasse. Sem isso não há diferença entre "ninguém olhou
-- ainda" e "já está sendo feito", que é a informação que o comercial quer.
--
-- Idempotente.

alter table crm_oportunidades
  -- AGUARDANDO (ganha, ninguém pegou) | ASSUMIDO (operações está fazendo)
  -- | CONCLUIDO (OV criada no app). Nulo = oportunidade que nunca foi ganha.
  add column if not exists repasse_status text,
  add column if not exists repasse_em timestamptz,
  -- Recado do comercial para operações: o que foi combinado com o cliente e que
  -- não cabe nos campos estruturados (prazo prometido, condição especial).
  -- É o conteúdo da mensagem de Teams que deixa de existir.
  add column if not exists repasse_nota text,
  add column if not exists repasse_assumido_por uuid references usuarios(id) on delete set null,
  add column if not exists repasse_assumido_em timestamptz;

-- Fila de trabalho de operações: as ganhas sem OV, mais antigas primeiro.
create index if not exists idx_crm_oport_repasse
  on crm_oportunidades (repasse_status, repasse_em)
  where ativo and repasse_status in ('AGUARDANDO', 'ASSUMIDO');

comment on column crm_oportunidades.repasse_status is
  'AGUARDANDO | ASSUMIDO | CONCLUIDO — repasse do ganho para operações de vendas gerar a OV.';

-- Oportunidades JÁ ganhas antes desta migration entram na fila no estado certo,
-- senão o histórico ficaria fora do painel e operações não veria o que está
-- pendente de verdade. `ganho_em` é a data real do repasse.
update crm_oportunidades
   set repasse_status = case when gerado_ov_id is null then 'AGUARDANDO' else 'CONCLUIDO' end,
       repasse_em = coalesce(ganho_em, atualizado_em, criado_em)
 where estagio = 'GANHO' and repasse_status is null;

-- ── Cotação: fechar o vínculo com a OV ──────────────────────────────────────────
-- Faltava: `crm_cotacao_service.gerar_ov` gravava o vínculo só na oportunidade,
-- então cotação aceita sem oportunidade perdia o rastro — e nada impedia gerar
-- a mesma OV duas vezes.
alter table crm_cotacoes
  add column if not exists gerado_ov_id uuid references pedidos(id) on delete set null,
  add column if not exists gerado_ov_ref text;
