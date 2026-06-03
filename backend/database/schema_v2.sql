-- ============================================================
-- ACE-MSB — Schema v2 — Redesign Fluxo Real MSB
-- Cole no SQL Editor do Supabase e execute
-- ============================================================

-- ── 1. Novos campos na tabela pedidos ────────────────────────

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS tipo_frete VARCHAR(30) CHECK (tipo_frete IN ('FOB','CIF_COM_VALOR','CIF_SEM_VALOR')),
  ADD COLUMN IF NOT EXISTS local_entrega VARCHAR(150);

-- Atualiza os status permitidos
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_status_check;
ALTER TABLE pedidos ADD CONSTRAINT pedidos_status_check CHECK (status IN (
  'LIBERADO',
  'EM_INVENTARIO',
  'AGUARD_VERIFICACAO',
  'DIVERGENCIA',
  'AGUARD_TRATATIVA',
  'EM_PROCESSO_SISTEMICO',
  'AGUARD_FATURAMENTO',
  'FATURADO',
  'AGUARD_COLETA',
  'COLETADO',
  'EXPEDIDO',
  'BLOQUEADO',
  'CANCELADO'
));

-- ── 2. Inventário Contínuo (itens por OV) ────────────────────

CREATE TABLE IF NOT EXISTS inventario_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id       UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  codigo_item     VARCHAR(50) NOT NULL,
  lote            VARCHAR(50) NOT NULL,
  qtd_sistemico   NUMERIC(12,3) NOT NULL DEFAULT 0,
  qtd_fisico      NUMERIC(12,3),
  qtd_venda       NUMERIC(12,3) NOT NULL DEFAULT 0,
  qtd_estoque     NUMERIC(12,3) GENERATED ALWAYS AS (
                    COALESCE(qtd_fisico, qtd_sistemico) - qtd_venda
                  ) STORED,
  status_item     VARCHAR(20) DEFAULT 'PENDENTE' CHECK (status_item IN ('PENDENTE','OK','DIVERGENCIA')),
  observacao      TEXT,
  operador_id     UUID REFERENCES usuarios(id),
  verificado_por  UUID REFERENCES usuarios(id),
  criado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventario_pedido ON inventario_itens(pedido_id);

-- ── 3. Cubagem ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cubagem (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id       UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  peso_kg         NUMERIC(10,3),
  altura_cm       NUMERIC(10,2),
  largura_cm      NUMERIC(10,2),
  comprimento_cm  NUMERIC(10,2),
  num_caixas      INTEGER,
  observacao      TEXT,
  registrado_por  UUID REFERENCES usuarios(id),
  criado_em       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── 4. Pallets ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pallets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo            VARCHAR(30) UNIQUE NOT NULL,
  transportadora_id UUID REFERENCES transportadoras(id),
  status            VARCHAR(20) DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','FECHADO','COLETADO')),
  data_prevista_coleta DATE,
  data_real_coleta  TIMESTAMP WITH TIME ZONE,
  observacao        TEXT,
  criado_em         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pallet_pedidos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pallet_id   UUID NOT NULL REFERENCES pallets(id) ON DELETE CASCADE,
  pedido_id   UUID NOT NULL REFERENCES pedidos(id),
  num_caixas  INTEGER,
  adicionado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(pedido_id)
);

CREATE INDEX IF NOT EXISTS idx_pallet_pedidos ON pallet_pedidos(pallet_id);

-- ── 5. Permissões para anon ──────────────────────────────────

GRANT ALL ON inventario_itens TO anon;
GRANT ALL ON cubagem TO anon;
GRANT ALL ON pallets TO anon;
GRANT ALL ON pallet_pedidos TO anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon;
