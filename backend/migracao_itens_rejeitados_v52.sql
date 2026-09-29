-- ─────────────────────────────────────────────────────────────────────────────
-- v52 — Linha do anexo que NÃO é item de pedido
--
-- O leitor de anexos às vezes traz uma linha que não é produto: na solicitação
-- 2026NE003966 ele extraiu "11 un × R$ 6,00 = R$ 66,00" com código "003966" e
-- sem descrição — 003966 é o sufixo da nota de empenho, não um produto. O valor
-- do pedido ficou R$ 66,00 mais caro e ninguém tinha como tirar.
--
-- Não bastava apagar da linha: `itens` está em _CAMPOS_DA_MAQUINA, então o
-- motor reescreve a lista a cada rodada e a remoção se desfaria sozinha em
-- horas. Por isso a rejeição vive FORA do registro e é reaplicada em toda
-- sincronização — é ela que faz o app aprender, e não esquecer.
--
-- A assinatura é o que identifica "a mesma linha" numa releitura. Guardamos
-- também o exemplo cru: quem for revisar isso daqui a seis meses precisa ver o
-- que foi rejeitado, não só um hash.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists licitacao_itens_rejeitados (
    id            uuid primary key default gen_random_uuid(),

    -- Identifica a linha entre releituras. Vem de `assinatura_do_item`:
    -- descrição normalizada quando existe, senão código + qtd + valor unitário.
    assinatura    text not null,

    -- A linha como o motor a leu, para conferência humana.
    exemplo       jsonb,
    -- Onde apareceu pela primeira vez. Não restringe a rejeição — serve para
    -- achar o caso de origem quando alguém questionar.
    entrada_id    uuid references licitacao_entrada(id) on delete set null,
    chave_grupo   text,

    motivo        text,
    rejeitado_por uuid references usuarios(id),
    criado_em     timestamptz not null default now(),

    -- Desfazer é `ativo = false`: a linha volta a ser item na próxima rodada, e
    -- o histórico de que um dia foi rejeitada continua.
    ativo         boolean not null default true
);

create unique index if not exists itens_rejeitados_assinatura
    on licitacao_itens_rejeitados (assinatura) where ativo;

comment on table licitacao_itens_rejeitados is
    'Linhas que o leitor de anexos extraiu e que NÃO são item de pedido. '
    'Reaplicadas em toda sincronização — o motor reescreve `itens` a cada rodada.';
