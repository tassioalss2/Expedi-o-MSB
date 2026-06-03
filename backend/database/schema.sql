-- ============================================================
-- ACE-MSB — Schema do Banco de Dados
-- Rodar no SQL Editor do Supabase (ou PostgreSQL direto)
-- ============================================================

-- Extensão para UUIDs automáticos
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USUÁRIOS ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usuarios (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome        VARCHAR(100) NOT NULL,
    email       VARCHAR(150) UNIQUE NOT NULL,
    senha_hash  VARCHAR(255) NOT NULL,
    perfil      VARCHAR(20) NOT NULL CHECK (perfil IN (
                    'OPERADOR','CONFERENTE','LIDER','SUPERVISOR',
                    'FATURAMENTO','QUALIDADE','GERENCIA','ADMIN')),
    ativo       BOOLEAN DEFAULT TRUE,
    criado_em   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── CLIENTES ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clientes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo      VARCHAR(30) UNIQUE NOT NULL,
    nome        VARCHAR(150) NOT NULL,
    cnpj        VARCHAR(20),
    contato     VARCHAR(100),
    prioridade  SMALLINT DEFAULT 0 CHECK (prioridade IN (0,1,2)),
    ativo       BOOLEAN DEFAULT TRUE
);

-- ── TRANSPORTADORAS ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transportadoras (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome        VARCHAR(100) NOT NULL,
    cnpj        VARCHAR(20),
    contato     VARCHAR(100),
    sla_horas   SMALLINT DEFAULT 24,
    ativo       BOOLEAN DEFAULT TRUE
);

-- ── PRODUTOS ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS produtos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo      VARCHAR(50) UNIQUE NOT NULL,
    descricao   VARCHAR(200) NOT NULL,
    familia     VARCHAR(80),
    unidade     VARCHAR(10) DEFAULT 'UN',
    ativo       BOOLEAN DEFAULT TRUE
);

-- ── LOTES ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lotes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    produto_id      UUID NOT NULL REFERENCES produtos(id),
    numero_lote     VARCHAR(50) NOT NULL,
    validade        DATE,
    quantidade_disp NUMERIC(12,3) DEFAULT 0,
    criado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(produto_id, numero_lote)
);

-- ── PEDIDOS ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pedidos (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    numero_pedido           VARCHAR(30) UNIQUE NOT NULL,
    cliente_id              UUID NOT NULL REFERENCES clientes(id),
    transportadora_id       UUID REFERENCES transportadoras(id),
    status                  VARCHAR(25) NOT NULL DEFAULT 'LIBERADO' CHECK (status IN (
                                'LIBERADO','EM_SEPARACAO','SEPARADO','EM_CONFERENCIA',
                                'DIVERGENCIA','AGUARD_TRATATIVA','CONFERIDO',
                                'AGUARD_FATURAMENTO','FATURADO','AGUARD_COLETA',
                                'COLETADO','EXPEDIDO','BLOQUEADO','CANCELADO')),
    prioridade              VARCHAR(10) DEFAULT 'NORMAL' CHECK (prioridade IN ('NORMAL','ALTA','CRITICA')),
    data_prevista_entrega   DATE NOT NULL,
    data_prevista_coleta    DATE,
    data_real_coleta        TIMESTAMP WITH TIME ZONE,
    numero_nf               VARCHAR(50),
    chave_nfe               VARCHAR(50),
    valor_nf                NUMERIC(12,2),
    observacoes             TEXT,
    criado_por              UUID REFERENCES usuarios(id),
    criado_em               TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    atualizado_em           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_data ON pedidos(data_prevista_entrega);
CREATE INDEX IF NOT EXISTS idx_pedidos_prioridade ON pedidos(prioridade);

-- ── ITENS DO PEDIDO ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS itens_pedido (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id       UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    produto_id      UUID NOT NULL REFERENCES produtos(id),
    lote_id         UUID REFERENCES lotes(id),
    qtd_solicitada  NUMERIC(12,3) NOT NULL CHECK (qtd_solicitada > 0),
    qtd_separada    NUMERIC(12,3),
    qtd_conferida   NUMERIC(12,3),
    qtd_divergente  NUMERIC(12,3),
    status_item     VARCHAR(20) DEFAULT 'PENDENTE' CHECK (status_item IN (
                        'PENDENTE','SEPARADO','CONFERIDO','DIVERGENCIA'))
);

CREATE INDEX IF NOT EXISTS idx_itens_pedido ON itens_pedido(pedido_id);

-- ── MOVIMENTAÇÕES (log imutável de status) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS movimentacoes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id       UUID NOT NULL REFERENCES pedidos(id),
    status_anterior VARCHAR(25),
    status_novo     VARCHAR(25) NOT NULL,
    usuario_id      UUID NOT NULL REFERENCES usuarios(id),
    observacao      TEXT,
    criado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mov_pedido ON movimentacoes(pedido_id);

-- ── SEPARAÇÕES ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS separacoes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id       UUID NOT NULL REFERENCES pedidos(id),
    operador_id     UUID NOT NULL REFERENCES usuarios(id),
    inicio          TIMESTAMP WITH TIME ZONE NOT NULL,
    fim             TIMESTAMP WITH TIME ZONE,
    observacao      TEXT
);

-- ── CONFERÊNCIAS ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conferencias (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id       UUID NOT NULL REFERENCES pedidos(id),
    conferente_id   UUID NOT NULL REFERENCES usuarios(id),
    resultado       VARCHAR(15) DEFAULT 'PENDENTE' CHECK (resultado IN ('PENDENTE','OK','DIVERGENCIA')),
    inicio          TIMESTAMP WITH TIME ZONE NOT NULL,
    fim             TIMESTAMP WITH TIME ZONE,
    observacao      TEXT
);

-- ── TRATATIVAS ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tratativas (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id           UUID NOT NULL REFERENCES pedidos(id),
    responsavel_id      UUID NOT NULL REFERENCES usuarios(id),
    decisao             VARCHAR(20) NOT NULL CHECK (decisao IN ('CORRIGIR','EXPEDIR_PARCIAL','BLOQUEAR')),
    justificativa       TEXT NOT NULL,
    retrabalho          BOOLEAN DEFAULT FALSE,
    tempo_retrabalho_min INT,
    criado_em           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── COLETAS ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coletas (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id       UUID NOT NULL REFERENCES pedidos(id),
    motorista       VARCHAR(100),
    placa           VARCHAR(15),
    protocolo       VARCHAR(50),
    data_real       TIMESTAMP WITH TIME ZONE NOT NULL,
    registrado_por  UUID REFERENCES usuarios(id),
    criado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── OCORRÊNCIAS ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ocorrencias (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id       UUID NOT NULL REFERENCES pedidos(id),
    tipo            VARCHAR(50) NOT NULL,
    descricao       TEXT NOT NULL,
    responsavel_id  UUID NOT NULL REFERENCES usuarios(id),
    status          VARCHAR(20) DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','EM_TRATATIVA','FECHADA')),
    resolucao       TEXT,
    resolvido_por   UUID REFERENCES usuarios(id),
    criado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolvido_em    TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_ocorrencias_status ON ocorrencias(status);
CREATE INDEX IF NOT EXISTS idx_ocorrencias_pedido ON ocorrencias(pedido_id);

-- ── ANEXOS ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS anexos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referencia_tipo VARCHAR(30) NOT NULL,
    referencia_id   UUID NOT NULL,
    nome_arquivo    VARCHAR(200) NOT NULL,
    caminho         VARCHAR(500) NOT NULL,
    tamanho_kb      INT,
    usuario_id      UUID REFERENCES usuarios(id),
    criado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── TRIGGER: atualiza atualizado_em automaticamente ──────────────────────────

CREATE OR REPLACE FUNCTION update_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pedidos_atualizado ON pedidos;
CREATE TRIGGER trg_pedidos_atualizado
    BEFORE UPDATE ON pedidos
    FOR EACH ROW EXECUTE FUNCTION update_atualizado_em();

-- ── USUÁRIO ADMIN INICIAL ─────────────────────────────────────────────────────
-- Senha: Admin@MSB2024 (hash bcrypt — troque após o primeiro login!)
INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES
    ('Administrador', 'admin@msb.com.br',
     '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TdmEL2Kz0mWu5EKK7E5Kf6v2Y2ey',
     'ADMIN')
ON CONFLICT (email) DO NOTHING;
