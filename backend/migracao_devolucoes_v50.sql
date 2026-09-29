-- ─────────────────────────────────────────────────────────────────────────────
-- v50 — Controle de devoluções
--
-- Os pedidos de devolução chegam por e-mail na caixa do Tassio, vindos do
-- comercial e do fiscal — não da licitação. Hoje eles vivem só na conversa do
-- Outlook: quem não estava no e-mail não sabe que existem, e ninguém consegue
-- dizer quantos estão abertos nem há quanto tempo.
--
-- A unidade aqui é a CONVERSA, não o e-mail. Medido nos 150 dias reais: 23
-- e-mails formam 10 casos. Guardar por e-mail faria a mesma devolução virar 5
-- cards — o erro que a tela de pendências acabou de corrigir.
--
-- O que o motor consegue extrair é PARCIAL, e a tabela assume isso: NF aparece
-- em 5 dos 10 casos, cliente em 3. Campo vazio fica vazio e a pessoa completa;
-- inventar dado aqui seria pior do que não ter.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists devolucoes (
    id              uuid primary key default gen_random_uuid(),

    -- De onde o caso veio. EMAIL = o motor trouxe; MANUAL = alguém abriu na tela
    -- (devolução combinada por telefone existe e não pode ficar de fora).
    origem          text not null default 'EMAIL',

    -- A chave anti-duplicata: o ConversationID do Outlook. É o que permite o
    -- motor rodar duas vezes por dia sem recriar o mesmo caso, e o que junta as
    -- 5 respostas de uma tratativa num card só.
    conversa_id     text,
    assunto         text,
    remetente       text,
    recebido_em     timestamptz,
    mensagens       integer not null default 1,

    -- O que foi lido do e-mail. Tudo opcional, de propósito.
    numeros_nf      text[],
    cliente_codigo  text,
    cliente_cnpj    text,
    cliente_id      uuid references clientes(id),
    produtos        text[],

    -- O controle em si.
    status          text not null default 'NOVA',
    motivo          text,
    observacao      text,
    responsavel     text,
    -- Cada passo com data, autor e o que mudou: é o que responde "em que pé
    -- está" sem precisar reabrir a conversa do Outlook.
    historico       jsonb not null default '[]'::jsonb,
    resolvido_em    timestamptz,
    resolucao       text,

    ativo           boolean not null default true,
    criado_em       timestamptz not null default now(),
    atualizado_em   timestamptz not null default now()
);

-- Uma conversa, um caso. Parcial (`where`) porque devolução manual não tem
-- conversa e as canceladas não devem bloquear uma reabertura pelo mesmo e-mail.
create unique index if not exists devolucoes_conversa_unica
    on devolucoes (conversa_id)
    where conversa_id is not null and ativo;

create index if not exists devolucoes_status on devolucoes (status) where ativo;
create index if not exists devolucoes_recebido on devolucoes (recebido_em desc);

comment on table devolucoes is
    'Pedidos de devolução que chegam por e-mail. Uma linha por CONVERSA do Outlook.';
comment on column devolucoes.conversa_id is
    'ConversationID do Outlook — chave anti-duplicata entre rodadas do motor.';
comment on column devolucoes.numeros_nf is
    'NFs citadas no e-mail. Vazio quando o texto não diz — não se inventa.';
