-- v15 (22/07/2026): Pregão como entidade mestre.
-- Modelo: ganha-se o PREGÃO (com o total de itens/quantidades). Depois vão
-- chegando as NOTAS DE EMPENHO (NE = empenhos), cada uma consumindo parte do
-- total do pregão. Cada NE gera suas OVs (fluxo atual, inalterado).
-- Empenhos legados (sem pregao_id) continuam funcionando como contratos soltos.
-- Aditiva e idempotente.

CREATE TABLE IF NOT EXISTS pregoes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    numero        text NOT NULL,
    cliente_id    uuid REFERENCES clientes(id),
    canal         text,
    tipo          text DEFAULT 'VENDA_DIRETA',
    data          date,
    vigencia      date,
    observacao    text,
    itens         jsonb DEFAULT '[]'::jsonb,   -- [{produto_id, codigo, descricao, qtd_total, valor_unitario}]
    ativo         boolean DEFAULT true,
    criado_em     timestamptz DEFAULT now(),
    atualizado_em timestamptz DEFAULT now()
);

-- Vínculo NE -> pregão mestre (nulo = empenho legado/solto).
ALTER TABLE empenhos ADD COLUMN IF NOT EXISTS pregao_id uuid REFERENCES pregoes(id);
