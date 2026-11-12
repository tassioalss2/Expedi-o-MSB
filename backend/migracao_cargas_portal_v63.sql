-- v63 — Espelho das cargas do Portal MSB.
--
-- O Kanban está saindo do ACE para o Portal MSB, e com ele as cargas. Sem as
-- cargas aqui, a conferência da fatura da transportadora morre: ela só
-- consegue dizer "esta cobrança está acima do previsto" porque tem a nossa
-- carga do lado do CT-e.
--
-- Esta tabela é ESPELHO, no mesmo espírito de notas_d365: ela guarda o que o
-- Portal diz, sem opinar e sem mexer no que a operação registrou. Por isso
-- nada aqui escreve em `pedidos` — se o Portal discordar do app, a divergência
-- é relatada para alguém decidir, não resolvida no escuro.
--
-- A chave é o LoadId do D365 (CG014460). Carga não muda de identidade: ela
-- muda de status. Reimportar atualiza a linha, não cria outra.
--
-- A OV entra como TEXTO, não como FK para pedidos: a carga existe mesmo
-- quando a OV não existe no app — e é exatamente isso que vai acontecer
-- quando o Kanban sair. Amarrar em FK faria o espelho recusar justamente a
-- carga que ele precisa guardar.

CREATE TABLE IF NOT EXISTS cargas_portal (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- LoadId do D365 (WHSLoadTableBiEntities.LoadId). A identidade da carga.
    carga_id            TEXT NOT NULL UNIQUE,

    -- Contexto da OV, como o Portal entrega. Texto de propósito (ver acima).
    numero_ov           TEXT,
    cliente_nome        TEXT,
    -- Conta do D365 (C001367). Bate com clientes.codigo — casamento exato,
    -- medido em 12/11/2026 contra o cadastro.
    cliente_codigo      TEXT,
    cliente_id          UUID REFERENCES clientes(id),

    -- Destino. Conferido contra local_entrega do app nas 25 OVs que existiam
    -- nos dois lados: zero divergências.
    cidade              TEXT,
    uf                  TEXT,

    numero_nf           TEXT,
    valor_nf            NUMERIC(14, 2),
    itens               INTEGER,

    -- Peso REAL da carga, em kg (WHSLoadTableBiEntities.LoadWeight). Só
    -- existe depois que a carga é criada no D365 — antes disso é nulo, e nulo
    -- aqui quer dizer "ainda não se sabe", nunca "zero".
    peso_kg             NUMERIC(12, 3),

    -- LoadStatus cru: Waved, Loaded, InProcess, Shipped.
    status              TEXT,
    -- A fase que o próprio Portal deduz: cotacao, pallet, remetido, outro.
    fase                TEXT,
    -- A etapa do Kanban novo onde a OV está (cotacao, liberado, faturado...).
    etapa_ov            TEXT,
    deposito            TEXT,
    -- Vem vazia em todas as 46 cargas de 12/11/2026 — o D365 não preenche.
    -- A coluna fica porque o campo existe lá e pode passar a ser preenchido.
    transportadora      TEXT,

    -- O tipo de frete como o D365 escreve (FreghtType_InoveProjects).
    tipo_frete_portal   TEXT,
    -- A tradução para o vocabulário do app, quando ela é segura. Medida em
    -- 12/11/2026 contra as OVs que existem nos dois lados:
    --   ChargeFreight     -> FOB             (8 de 8)
    --   PrepaidWithoutNFe -> CIF_SEM_VALOR  (11 de 12)
    --   Prepayd           -> CIF_COM_VALOR   (1 de 1, amostra de um)
    -- "Blank" e vazio não traduzem: ficam nulos, porque frete indefinido no
    -- D365 não vira tipo de frete por conveniência nossa.
    tipo_frete          TEXT,

    envio_em            TIMESTAMP WITH TIME ZONE,
    expedido_em         TIMESTAMP WITH TIME ZONE,
    envio_confirmado_em TIMESTAMP WITH TIME ZONE,
    entrega_prevista    TIMESTAMP WITH TIME ZONE,
    ov_criada_em        TIMESTAMP WITH TIME ZONE,

    -- O card inteiro do Portal. Guardar o bruto é o que permite descobrir
    -- depois um campo que hoje não sei ler, sem ter de reimportar o passado.
    payload             JSONB,

    importado_em        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    importado_por       UUID REFERENCES usuarios(id),
    criado_em           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    atualizado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cargas_portal_ov      ON cargas_portal(numero_ov);
CREATE INDEX IF NOT EXISTS idx_cargas_portal_nf      ON cargas_portal(numero_nf);
CREATE INDEX IF NOT EXISTS idx_cargas_portal_status  ON cargas_portal(status);
CREATE INDEX IF NOT EXISTS idx_cargas_portal_envio   ON cargas_portal(envio_em);

COMMENT ON TABLE cargas_portal IS
    'Espelho das cargas do Portal MSB (API /api/kanban-ov, que le o D365). '
    'Mantem a conferencia da fatura de frete viva depois que o Kanban sair do '
    'ACE. Nao escreve em pedidos: divergencia e relatada, nao resolvida.';

COMMENT ON COLUMN cargas_portal.peso_kg IS
    'Peso real da carga em kg, do D365. Nulo = ainda nao se sabe, nunca zero.';

COMMENT ON COLUMN cargas_portal.tipo_frete IS
    'Traducao do tipo do D365 para o vocabulario do app, so quando segura. '
    'Nulo quando o D365 nao definiu.';
