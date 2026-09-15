-- v47 · Conferência da fatura de frete
--
-- A transportadora manda a cada 15 dias um zip com os CT-e do período e o(s)
-- boleto(s). Hoje a operadora abre DACTE por DACTE, soma à mão e compara com o
-- boleto — procurando CT-e duplicado e CT-e que não é da MSB.
--
-- Medido no período de 16 a 31/08 da RR (42 CT-e, R$ 25.505,75): a soma bate
-- exata, não há duplicado nem CT-e de terceiro. O que a conferência manual NÃO
-- vê, e que apareceu sozinho ao cruzar com as nossas OVs:
--
--     16 CT-e cobram diferente do previsto na OV ..... R$ 1.826,39 a mais
--      7 CT-e cobram NF que não existe no app ........ R$ 11.277,59
--      3 NFs saíram pela RR e não têm CT-e ........... R$ 1.193,24
--
-- Uma dessas sete é um CT-e de R$ 8.304,20 com destino BIOMEDICAL — um terço do
-- boleto inteiro. É exatamente o tipo de coisa que a soma manual não pega,
-- porque a soma FECHA.
--
-- RETENÇÃO DE 3 MESES, pedida pelo Tássio para o app não pesar. A limpeza roda
-- na criação de cada conferência nova (mesmo padrão do histórico do motor), e
-- não por job: sem agendador, o que não roda junto com o uso não roda nunca.
CREATE TABLE IF NOT EXISTS frete_conferencias (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transportadora text,
    -- O período que a fatura cobre, como a transportadora manda (dia 1 a 15,
    -- 16 a 30/31). Vem do nome do arquivo ou das datas dos CT-e.
    periodo_de     date,
    periodo_ate    date,
    vencimento     date,
    -- Somas, guardadas prontas: é o que a tela mostra primeiro e o que o
    -- histórico compara mês a mês sem reabrir os documentos.
    total_boletos  numeric(14,2) NOT NULL DEFAULT 0,
    total_ctes     numeric(14,2) NOT NULL DEFAULT 0,
    qtd_ctes       integer NOT NULL DEFAULT 0,
    qtd_boletos    integer NOT NULL DEFAULT 0,
    -- O resultado dos cinco testes, para a tela não recalcular e para o
    -- histórico poder dizer "no período passado sobraram 7 sem NF".
    achados        jsonb,
    arquivo        text,
    criado_por     uuid REFERENCES usuarios(id),
    criado_em      timestamptz NOT NULL DEFAULT now()
);

-- Um CT-e por linha. Guardado porque é o detalhe que a operadora abre quando
-- vai contestar com a transportadora — e sem ele o histórico seria só um total.
CREATE TABLE IF NOT EXISTS frete_conferencia_ctes (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conferencia_id uuid NOT NULL REFERENCES frete_conferencias(id) ON DELETE CASCADE,
    numero         text,
    -- Chave de acesso do CT-e (44 dígitos). É ela que identifica duplicata:
    -- número pode repetir entre séries, a chave não repete nunca.
    chave          text,
    emissao        date,
    valor          numeric(14,2) NOT NULL DEFAULT 0,
    remetente      text,
    destinatario   text,
    -- As NF-e que o CT-e transporta, como números ["20410"].
    notas          jsonb,
    -- O que a conferência concluiu desta linha: OK, VALOR_DIFERENTE,
    -- NF_DESCONHECIDA, DUPLICADO, NAO_E_NOSSO.
    situacao       text,
    -- O frete que a OV previa, quando a NF foi encontrada. Nulo = não achou.
    previsto       numeric(14,2),
    ov             text
);

CREATE INDEX IF NOT EXISTS ix_frete_ctes_conferencia
    ON frete_conferencia_ctes(conferencia_id);
CREATE INDEX IF NOT EXISTS ix_frete_conferencias_periodo
    ON frete_conferencias(periodo_de DESC);

COMMENT ON TABLE frete_conferencias IS
    'Uma conferência de fatura de frete. Retenção de 3 meses: a limpeza roda '
    'na criação de cada conferência nova.';
COMMENT ON COLUMN frete_conferencia_ctes.chave IS
    'Chave de acesso de 44 dígitos do CT-e. É por ela que se detecta duplicata '
    '— número de CT-e pode repetir entre séries, a chave não.';
COMMENT ON COLUMN frete_conferencia_ctes.previsto IS
    'O valor_frete que a OV previa. A diferença contra `valor` é o achado que '
    'a conferência manual não vê, porque a soma do boleto fecha mesmo assim.';
