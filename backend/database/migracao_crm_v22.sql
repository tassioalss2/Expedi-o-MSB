-- v22 (29/07/2026): CRM no processo real — empresas prospectadas/qualificadas,
-- ciclo de 1 ano, desafios rastreáveis e proposta como último passo.
--
-- POR QUE TROCAR "LEAD" POR "EMPRESA":
-- O processo tem dois BANCOS de empresas (prospectadas e qualificadas), e uma
-- empresa volta a prospectada depois de 1 ano sem movimentação — ou seja, ela é
-- qualificada VÁRIAS vezes ao longo dos anos. "Lead" é abstração de uso único:
-- nasce, converte ou morre. Empresa é registro permanente com estado e histórico.
-- Modelar como lead obrigava a duplicar a empresa a cada ciclo.
--
-- O QUE MUDA NO FUNIL:
--   antes:  Qualificada → Proposta → Negociação → Ganho/Perdido
--   agora:  Qualificada → [Desafios] → Negociação → Proposta → Ganho/Perdido
-- A proposta passou a ser o ÚLTIMO passo (é ela que decide ganho/perda), e
-- Desafios é etapa opcional: o que trava o avanço não é "passar por lá", é ter
-- desafio bloqueante aberto.
-- Idempotente.

-- ── Empresas: o registro permanente ─────────────────────────────────────────────
create table if not exists crm_empresas (
  id uuid primary key default gen_random_uuid(),

  -- Identificação. O CNPJ é a chave de deduplicação: em prospecção ativa o erro
  -- mais comum é dois vendedores mapearem a mesma empresa.
  cnpj text,
  razao_social text not null,
  nome_fantasia text,
  cidade text,
  uf text,
  -- HOSPITAL | CLINICA | DISTRIBUIDOR | LABORATORIO | OUTRO
  tipo text,
  -- PEQUENO | MEDIO | GRANDE
  porte text,

  -- Vínculo com a base de clientes, quando já compra da gente.
  cliente_id uuid references clientes(id) on delete set null,
  canal text,
  -- De onde veio o mapeamento (CNES, congresso, indicação, prospecção fria...).
  -- Guardado para medir qual fonte de prospecção converte.
  fonte text,

  -- PROSPECTADA | QUALIFICADA | CLIENTE | DESCARTADA
  estado text not null default 'PROSPECTADA',

  -- Qualificação VIGENTE (o que compra, quem decide, quando, verba).
  -- Fica nula quando a empresa volta a prospectada — o conteúdo não se perde,
  -- vai para crm_qualificacao_historico.
  qualificacao jsonb,
  qualificada_em timestamptz,

  -- Relógio do ciclo de 1 ano. É movimentação de VERDADE (contato registrado,
  -- atividade, mudança de etapa, proposta), não "registro editado" — senão
  -- corrigir um telefone reiniciaria o ano.
  ultima_movimentacao_em timestamptz,
  -- Quantas vezes já voltou para prospecção. Empresa que cicla várias vezes sem
  -- fechar é sinal de que o perfil não é o nosso.
  ciclos_retorno int not null default 0,
  retornou_em timestamptz,

  score int not null default 0,
  temperatura text,
  score_detalhe jsonb,

  proximo_passo text,
  proximo_passo_em date,

  motivo_descarte_codigo text,
  motivo_descarte text,

  responsavel_id uuid references usuarios(id) on delete set null,
  observacao text,
  ativo boolean not null default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

-- Deduplicação por CNPJ entre as ativas. Parcial porque CNPJ é opcional (dá para
-- mapear uma empresa antes de descobrir o CNPJ) e descartadas não devem bloquear.
create unique index if not exists idx_crm_empresas_cnpj
  on crm_empresas (cnpj) where ativo and cnpj is not null;
create index if not exists idx_crm_empresas_estado on crm_empresas (estado) where ativo;
create index if not exists idx_crm_empresas_score on crm_empresas (score desc) where ativo;
create index if not exists idx_crm_empresas_movimentacao
  on crm_empresas (ultima_movimentacao_em) where ativo;

-- ── Histórico de qualificações: nunca se perde ──────────────────────────────────
-- Pedido explícito do processo: quando a empresa volta a prospectada, a
-- informação levantada na qualificação anterior tem que continuar disponível —
-- para quem requalificar comparar ("ano passado eram 40/mês, mudou?") em vez de
-- começar de uma tela branca.
create table if not exists crm_qualificacao_historico (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references crm_empresas(id) on delete cascade,
  dados jsonb not null,
  score int,
  qualificada_em timestamptz,
  encerrada_em timestamptz default now(),
  -- RETORNO_1_ANO | REQUALIFICADA | DESCARTE
  motivo_encerramento text,
  responsavel_id uuid references usuarios(id) on delete set null,
  criado_em timestamptz default now()
);

create index if not exists idx_crm_qual_hist_empresa
  on crm_qualificacao_historico (empresa_id, encerrada_em desc);

-- ── Desafios: vocabulário que aprende ───────────────────────────────────────────
-- O operador escreve o problema com as palavras dele; o sistema normaliza e
-- cadastra como tipo reutilizável. Assim não há lista rígida (que nunca cobre a
-- realidade) nem texto livre (que impede agrupar). O `slug` é a chave de
-- deduplicação, e `usos` ordena o autocomplete — quem digita "cadastro" recebe o
-- tipo que já existe em vez de criar a 50ª variação do mesmo problema.
create table if not exists crm_desafio_tipos (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  slug text not null,
  usos int not null default 0,
  criado_por uuid references usuarios(id) on delete set null,
  ativo boolean not null default true,
  criado_em timestamptz default now()
);

create unique index if not exists idx_crm_desafio_tipos_slug on crm_desafio_tipos (slug);

-- Tipos confirmados pelo time como os que mais travam. Os demais nascem do uso.
insert into crm_desafio_tipos (label, slug) values
  ('Cadastro de fornecedor / homologação no hospital', 'cadastro de fornecedor homologacao no hospital'),
  ('Registro ANVISA / documentação técnica do produto', 'registro anvisa documentacao tecnica do produto'),
  ('Amostra / teste / demonstração com o médico', 'amostra teste demonstracao com o medico'),
  ('Preço-alvo abaixo do que conseguimos praticar', 'preco alvo abaixo do que conseguimos praticar')
on conflict (slug) do nothing;

create table if not exists crm_desafios (
  id uuid primary key default gen_random_uuid(),
  oportunidade_id uuid not null references crm_oportunidades(id) on delete cascade,
  tipo_id uuid references crm_desafio_tipos(id) on delete set null,
  -- Texto do caso concreto (o tipo é a categoria; aqui vai o detalhe).
  descricao text,
  -- Bloqueante impede avançar para Negociação — é o "resolver antes de negociar".
  -- Nem todo desafio bloqueia: alguns correm em paralelo.
  bloqueia boolean not null default true,
  -- ABERTO | RESOLVIDO | CANCELADO
  status text not null default 'ABERTO',
  responsavel_id uuid references usuarios(id) on delete set null,
  prazo date,
  resolucao text,
  resolvido_em timestamptz,
  criado_por uuid references usuarios(id) on delete set null,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create index if not exists idx_crm_desafios_oportunidade
  on crm_desafios (oportunidade_id, status);
create index if not exists idx_crm_desafios_abertos
  on crm_desafios (status, prazo) where status = 'ABERTO';

-- ── Oportunidades: nova etapa e vínculo com a empresa ───────────────────────────
alter table crm_oportunidades
  add column if not exists empresa_id uuid references crm_empresas(id) on delete set null;

create index if not exists idx_crm_oport_empresa on crm_oportunidades (empresa_id) where ativo;

-- A proposta virou o último passo antes do fechamento, então quem estava em
-- PROPOSTA (etapa que antes vinha ANTES de negociar) na verdade ainda estava
-- negociando. Move para NEGOCIACAO em vez de promover indevidamente.
update crm_oportunidades set estagio = 'NEGOCIACAO'
 where estagio = 'PROPOSTA'
   and not exists (
     select 1 from crm_cotacoes c
      where c.oportunidade_id = crm_oportunidades.id
        and c.ativo
        and (c.enviada_em is not null or c.status in ('ENVIADA', 'ACEITA', 'RECUSADA'))
   );

comment on column crm_oportunidades.estagio is
  'QUALIFICACAO | DESAFIOS | NEGOCIACAO | PROPOSTA | GANHO | PERDIDO';
comment on column crm_empresas.estado is
  'PROSPECTADA | QUALIFICADA | CLIENTE | DESCARTADA';
comment on column crm_empresas.ultima_movimentacao_em is
  'Última movimentação real (contato, atividade, etapa, proposta). Base do retorno automático a PROSPECTADA após 1 ano.';

-- ── crm_leads sai de cena ───────────────────────────────────────────────────────
-- Substituída por crm_empresas (superset: mesmo conteúdo + perfil da empresa +
-- estado + histórico). O DROP só acontece se estiver vazia — se alguém já tiver
-- cadastrado leads, a tabela fica de pé para migração manual em vez de perder dado.
do $$
declare n int;
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'public' and table_name = 'crm_leads') then
    execute 'select count(*) from crm_leads' into n;
    if n = 0 then
      execute 'drop table crm_leads';
      raise notice 'crm_leads estava vazia e foi removida (substituida por crm_empresas).';
    else
      raise warning 'crm_leads tem % linha(s) — NAO foi removida. Migre para crm_empresas antes de dropar.', n;
    end if;
  end if;
end $$;
