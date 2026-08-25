-- v16 · Um comunicado de uso, várias notas fiscais
--
-- O e-mail da licitação chega assim:
--
--     NF 20476 e NF 20480, referente ao comunicado de uso 57048
--     NF 20482,            referente ao comunicado de uso 57046
--     NF 20485 e NF 20489, referente ao comunicado de uso 57044
--
-- Ou seja: a AF (comunicado) é UMA, as notas são VÁRIAS, e cada nota cobre
-- itens e quantidades próprios. O app só aceitava uma NF por AF, e a regra
-- anti-duplicidade (uma demanda ativa por número) barrava a segunda nota da
-- mesma AF com 409 — exatamente o caso normal do processo.
--
-- `notas` guarda a lista. As colunas antigas continuam preenchidas com a
-- PRIMEIRA nota e com a soma dos itens, porque o painel, o relatório e a busca
-- leem de lá; mexer nelas agora seria trocar um problema por três.

ALTER TABLE licitacao_demandas
  ADD COLUMN IF NOT EXISTS notas jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN licitacao_demandas.notas IS
  'Notas fiscais do comunicado de uso: [{numero_nf, numero_pedido, itens:[{produto_id, codigo, descricao, qtd, valor}]}]. '
  'A AF é uma; as notas são várias. numero_nf/itens (colunas) espelham a primeira nota e a soma dos itens, para o painel e o relatório.';

-- Backfill: o que já existe tem uma nota só — a que está nas colunas antigas.
UPDATE licitacao_demandas
   SET notas = jsonb_build_array(
         jsonb_build_object(
           'numero_nf',     numero_nf,
           'numero_pedido', gerado_ref,
           'itens',         COALESCE(itens, '[]'::jsonb)
         )
       )
 WHERE tipo_operacao = 'COMUNICADO_USO'
   AND numero_nf IS NOT NULL
   AND notas = '[]'::jsonb;

-- Conferência (rode e olhe antes de seguir):
--   SELECT numero AS af, numero_nf AS nf_antiga,
--          jsonb_array_length(notas) AS qtd_notas, notas
--     FROM licitacao_demandas
--    WHERE tipo_operacao = 'COMUNICADO_USO'
--    ORDER BY criado_em DESC
--    LIMIT 20;
