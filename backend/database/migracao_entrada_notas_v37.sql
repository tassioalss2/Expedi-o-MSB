-- v37 · As anotações da caixa de entrada passam a ser histórico
--
-- Estava errado: `licitacao_entrada.observacao` é uma coluna de texto só, e cada
-- nota nova sobrescrevia a anterior em silêncio. Quem anotasse "verificar com a
-- Laisa" e depois "cliente pediu a marca Merit" perdia a primeira — e num
-- processo em que o caso fica 30 dias aberto e passa por mais de uma pessoa, é
-- justamente o histórico que explica por que ele está parado.
--
-- Vira tabela própria, com autor e data. As notas que já existem entram como a
-- primeira do histórico, incluindo as 26 que vieram da triagem da planilha.
CREATE TABLE IF NOT EXISTS licitacao_entrada_notas (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entrada_id  uuid NOT NULL REFERENCES licitacao_entrada(id) ON DELETE CASCADE,
    texto       text NOT NULL,
    -- Nulo nas notas herdadas da coluna antiga: não há como saber quem escreveu.
    autor_id    uuid REFERENCES usuarios(id),
    criado_em   timestamptz NOT NULL DEFAULT now()
);

-- A leitura é sempre "as notas deste caso, em ordem".
CREATE INDEX IF NOT EXISTS ix_entrada_notas_entrada
    ON licitacao_entrada_notas(entrada_id, criado_em);

-- Traz o que já estava escrito. `atualizado_em` como data é uma aproximação —
-- é quando o registro mudou por último, não necessariamente quando a nota foi
-- escrita —, mas é o melhor que existe e perder a nota seria pior.
INSERT INTO licitacao_entrada_notas (entrada_id, texto, criado_em)
SELECT id, btrim(observacao), COALESCE(atualizado_em, criado_em)
  FROM licitacao_entrada
 WHERE observacao IS NOT NULL AND btrim(observacao) <> ''
   AND NOT EXISTS (
       SELECT 1 FROM licitacao_entrada_notas n WHERE n.entrada_id = licitacao_entrada.id
   );

-- A coluna antiga NÃO é removida. Ela deixa de ser escrita e lida, mas fica
-- como registro de origem: se a cópia acima tiver perdido algo, o texto
-- original ainda está lá para conferir.
COMMENT ON COLUMN licitacao_entrada.observacao IS
    'OBSOLETA desde a v37 — as anotações vivem em licitacao_entrada_notas. '
    'Mantida apenas como registro do que existia antes da migração.';

COMMENT ON TABLE licitacao_entrada_notas IS
    'Histórico de anotações de uma solicitação da licitação. Acumula: nota nova '
    'não apaga a anterior.';
