-- v61 — Operações do D365 ensinadas pelo usuário.
--
-- Até aqui a tradução "texto da operação fiscal -> natureza" vivia só no
-- código (MAPA_OPERACAO). Quando o D365 emite uma operação nova, o app avisa
-- que não sabe o que é e não há nada a fazer na tela: é preciso mexer no
-- código e subir uma versão. Esta tabela é o lugar onde o Tássio responde.
--
-- O que é ensinado aqui vale ANTES do mapa do código: se alguém ensinou, é
-- porque viu a nota e o código não sabia.

CREATE TABLE IF NOT EXISTS operacoes_d365_mapa (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Texto normalizado (minúsculo, sem acento) da operação fiscal do D365.
    operacao        TEXT NOT NULL UNIQUE,
    -- Como veio na nota, para a tela mostrar o que a pessoa de fato leu.
    operacao_exibe  TEXT,
    -- VENDA_NORMAL, COMUNICADO_USO, DEVOLUCAO, REMESSA, CONSIGNADO, ...
    tipo_operacao   TEXT NOT NULL,
    -- LICITACAO ou COMERCIAL. Nulo = o app decide pelo resto da nota.
    origem_venda    TEXT,
    observacao      TEXT,
    ensinado_por    UUID REFERENCES usuarios(id),
    criado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    atualizado_em   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_op_d365_operacao ON operacoes_d365_mapa(operacao);

COMMENT ON TABLE operacoes_d365_mapa IS
    'Operacoes fiscais do D365 que o usuario classificou pela tela. Consultada '
    'antes do MAPA_OPERACAO do codigo.';
