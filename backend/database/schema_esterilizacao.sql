-- ============================================================
-- ACE-MSB — Módulo de Esterilização
-- Rodar no SQL Editor do Supabase após o schema.sql principal
-- ============================================================

-- ── PRODUTOS ESTÉREIS ─────────────────────────────────────────────────────────
-- Cadastro enriquecido com campos específicos de esterilização
-- (complementa a tabela 'produtos' existente com dados de tempo e caixa)

CREATE TABLE IF NOT EXISTS produtos_estereis (
    codigo_sa                   VARCHAR(50) PRIMARY KEY,
    codigo_pa                   VARCHAR(50),
    descricao                   VARCHAR(200) NOT NULL,
    familia                     VARCHAR(100),
    tipo_produto                VARCHAR(80),
    qtd_padrao_cx_verde         INTEGER,
    qtd_padrao_cx_branca        INTEGER,
    qtd_padrao_cx_amarela       INTEGER,
    qtd_padrao_cx_vermelha      INTEGER,
    tipo_caixa_padrao           VARCHAR(20) CHECK (tipo_caixa_padrao IN ('VERDE','BRANCA','AMARELA','VERMELHA')),
    valor_unitario              NUMERIC(10,4) DEFAULT 0,
    tempo_producao_seg          INTEGER DEFAULT 0,  -- por unidade
    tempo_separacao_seg         INTEGER DEFAULT 0,  -- por unidade
    requer_esterilizacao        BOOLEAN DEFAULT TRUE,
    ativo                       BOOLEAN DEFAULT TRUE,
    criado_em                   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    atualizado_em               TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pe_familia ON produtos_estereis(familia);
CREATE INDEX IF NOT EXISTS idx_pe_codigo_pa ON produtos_estereis(codigo_pa);
CREATE INDEX IF NOT EXISTS idx_pe_ativo ON produtos_estereis(ativo);

-- ── CARGAS DE ESTERILIZAÇÃO ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cargas_esterilizacao (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    numero_carga                VARCHAR(30) UNIQUE NOT NULL,
    mes_referencia              SMALLINT CHECK (mes_referencia BETWEEN 1 AND 12),
    semana_referencia           SMALLINT CHECK (semana_referencia BETWEEN 1 AND 53),
    ano_referencia              SMALLINT NOT NULL DEFAULT EXTRACT(YEAR FROM NOW()),
    data_inicio_planejada       DATE,
    hora_inicio_planejada       TIME,
    data_saida_prevista         DATE NOT NULL,
    data_saida_real             DATE,
    data_retorno_prevista       DATE,
    data_retorno_real           DATE,
    status                      VARCHAR(20) NOT NULL DEFAULT 'PLANEJADA'
                                    CHECK (status IN (
                                        'PLANEJADA','LIBERADA','EM_PRODUCAO','EM_SEPARACAO',
                                        'EM_CONFERENCIA','PRONTA','ENVIADA','RETORNADA',
                                        'ATRASADA','BLOQUEADA','CANCELADA'
                                    )),
    prioridade                  VARCHAR(10) NOT NULL DEFAULT 'NORMAL'
                                    CHECK (prioridade IN ('ALTA','NORMAL','BAIXA')),
    responsavel_planejamento    VARCHAR(100),
    responsavel_operacao        VARCHAR(100),
    observacao                  TEXT,
    valor_total                 NUMERIC(14,2) DEFAULT 0,
    tempo_total_estimado_min    INTEGER DEFAULT 0,
    tempo_total_real_min        INTEGER,
    quantidade_total_pecas      INTEGER DEFAULT 0,
    quantidade_total_caixas     INTEGER DEFAULT 0,
    motivo_bloqueio             TEXT,
    motivo_replanejamento       TEXT,
    criado_por                  UUID REFERENCES usuarios(id),
    criado_em                   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    atualizado_em               TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ce_status ON cargas_esterilizacao(status);
CREATE INDEX IF NOT EXISTS idx_ce_data_saida ON cargas_esterilizacao(data_saida_prevista);
CREATE INDEX IF NOT EXISTS idx_ce_mes_ano ON cargas_esterilizacao(ano_referencia, mes_referencia);
CREATE INDEX IF NOT EXISTS idx_ce_prioridade ON cargas_esterilizacao(prioridade);

-- ── ITENS DA CARGA ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS itens_carga (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_carga                    UUID NOT NULL REFERENCES cargas_esterilizacao(id) ON DELETE CASCADE,
    codigo_sa                   VARCHAR(50) NOT NULL,
    codigo_pa                   VARCHAR(50),
    descricao_produto           VARCHAR(200),
    familia                     VARCHAR(100),
    quantidade                  INTEGER NOT NULL CHECK (quantidade > 0),
    quantidade_por_caixa        INTEGER,
    tipo_caixa                  VARCHAR(20) CHECK (tipo_caixa IN ('VERDE','BRANCA','AMARELA','VERMELHA')),
    quantidade_caixas           INTEGER,          -- calculado: CEIL(qtd / qtd_cx)
    modelo_carga                VARCHAR(100),
    valor_unitario              NUMERIC(10,4) DEFAULT 0,
    valor_total                 NUMERIC(14,2) DEFAULT 0,  -- calculado
    tempo_producao_unitario_seg INTEGER DEFAULT 0,
    tempo_separacao_unitario_seg INTEGER DEFAULT 0,
    tempo_producao_total_min    INTEGER DEFAULT 0,  -- calculado
    tempo_separacao_total_min   INTEGER DEFAULT 0,  -- calculado
    tempo_total_min             INTEGER DEFAULT 0,  -- calculado
    observacao                  TEXT,
    criado_em                   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ic_carga ON itens_carga(id_carga);
CREATE INDEX IF NOT EXISTS idx_ic_sa ON itens_carga(codigo_sa);

-- ── APONTAMENTOS DOS OPERADORES ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS apontamentos_carga (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_carga                    UUID NOT NULL REFERENCES cargas_esterilizacao(id),
    etapa                       VARCHAR(30) NOT NULL
                                    CHECK (etapa IN (
                                        'PRODUCAO','SEPARACAO','CONFERENCIA','EMBALAGEM'
                                    )),
    operador                    VARCHAR(100) NOT NULL,
    data_inicio                 TIMESTAMP WITH TIME ZONE NOT NULL,
    data_fim                    TIMESTAMP WITH TIME ZONE,
    duracao_real_min            INTEGER,   -- calculado ao finalizar
    status                      VARCHAR(20) DEFAULT 'INICIADO'
                                    CHECK (status IN ('INICIADO','PAUSADO','CONCLUIDO')),
    problema_reportado          TEXT,
    observacao                  TEXT,
    criado_em                   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ap_carga ON apontamentos_carga(id_carga);

-- ── HISTÓRICO DE ALTERAÇÕES ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS historico_carga (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_carga                    UUID NOT NULL REFERENCES cargas_esterilizacao(id),
    campo_alterado              VARCHAR(100) NOT NULL,
    valor_anterior              TEXT,
    valor_novo                  TEXT,
    usuario                     VARCHAR(100) NOT NULL,
    motivo                      TEXT,
    criado_em                   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hc_carga ON historico_carga(id_carga);

-- ── TRIGGER: atualiza atualizado_em ──────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_cargas_atualizado ON cargas_esterilizacao;
CREATE TRIGGER trg_cargas_atualizado
    BEFORE UPDATE ON cargas_esterilizacao
    FOR EACH ROW EXECUTE FUNCTION update_atualizado_em();

DROP TRIGGER IF EXISTS trg_pe_atualizado ON produtos_estereis;
CREATE TRIGGER trg_pe_atualizado
    BEFORE UPDATE ON produtos_estereis
    FOR EACH ROW EXECUTE FUNCTION update_atualizado_em();

-- ── SEQUENCE para número da carga ────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS seq_numero_carga START 1;

-- ── DADOS DE EXEMPLO (comentar em produção) ───────────────────────────────────
/*
INSERT INTO produtos_estereis (codigo_sa, codigo_pa, descricao, familia, tipo_caixa_padrao,
    qtd_padrao_cx_verde, valor_unitario, tempo_producao_seg, tempo_separacao_seg)
VALUES
    ('SA-001', 'PA-2301', 'Luva Cirúrgica Estéril P', 'LUVA CIRÚRGICA', 'VERDE', 50, 2.50, 8, 4),
    ('SA-002', 'PA-2302', 'Luva Cirúrgica Estéril M', 'LUVA CIRÚRGICA', 'VERDE', 50, 2.50, 8, 4),
    ('SA-003', 'PA-2303', 'Luva Cirúrgica Estéril G', 'LUVA CIRÚRGICA', 'VERDE', 50, 2.50, 8, 4),
    ('SA-010', 'PA-3101', 'Cateter Central 7Fr', 'CATETER', 'BRANCA', 20, 45.00, 30, 15),
    ('SA-011', 'PA-3102', 'Cateter Periférico 20G', 'CATETER', 'BRANCA', 40, 12.00, 15, 8);
*/
