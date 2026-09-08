-- v40 · Reclassificar o tipo, e guardar POR QUE — para o motor deixar de errar
--
-- O tipo é a parte menos confiável do módulo, e isto foi medido, não suposto.
-- Em 08/09/2026, dos 188 casos da janela de 90 dias, apenas 32 tinham algum
-- veredito humano sobre o tipo (os que viraram demanda, onde alguém escolheu
-- `tipo_operacao` à mão). Desses 32, o motor errou 1 — as 4 mensagens da NE
-- 2026NE1051, cujo assunto é literalmente "2026NE1051": o assunto não
-- classifica nada, o classificador caiu no corpo, o corpo citava nota fiscal e
-- saiu "comunicado de uso" onde a pessoa disse "venda direta".
--
-- O problema maior é o que NÃO foi medido: dos 32 conferidos, 1 é comunicado de
-- uso e ZERO são consignação. Ou seja, os dois tipos que somam 90 casos nunca
-- passaram por conferência de ninguém, porque comunicado de uso raramente vira
-- demanda com tipo escolhido. Não existe taxa de erro conhecida para eles.
--
-- Esta migração cria o que fecha esse buraco: a pessoa corrige, e a correção
-- fica como EVIDÊNCIA — assunto e início do corpo congelados no momento da
-- correção, mais o motivo escrito por ela. Com isso a regra do motor deixa de
-- ser opinião: cada mudança em `classifica.py` pode ser medida contra todas as
-- correções já feitas, e uma regra nova que quebre uma correção antiga aparece
-- na hora.

-- O tipo da máquina continua em `tipo`, reescrito a cada rodada (o motor melhora
-- a extração e o registro deve melhorar também). A decisão da pessoa vive à
-- parte, e é ela que vale na tela. Separar é o que impede a rodada das 14:00 de
-- apagar a correção feita às 11:00 — o mesmo princípio da situação e da nota.
ALTER TABLE licitacao_entrada
    ADD COLUMN IF NOT EXISTS tipo_manual     text,
    ADD COLUMN IF NOT EXISTS tipo_manual_por uuid REFERENCES usuarios(id),
    ADD COLUMN IF NOT EXISTS tipo_manual_em  timestamptz,
    -- Correção que a pessoa fez em OUTRA mensagem da mesma conversa e que este
    -- e-mail herdou. Marcada como herdada de propósito: é decisão emprestada,
    -- não conferida aqui, e a tela precisa poder dizer isso.
    ADD COLUMN IF NOT EXISTS tipo_herdado    boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS licitacao_reclassificacoes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entrada_id      uuid REFERENCES licitacao_entrada(id) ON DELETE SET NULL,
    -- A conversa é o que permite a correção valer para as próximas mensagens do
    -- mesmo assunto, sem adivinhar nada.
    conversation_id text,
    chave_grupo     text,
    -- CONGELADOS no momento da correção, e é isto que faz da tabela um conjunto
    -- de testes em vez de um log. Se o assunto for relido depois, a evidência
    -- que justificou a correção continua aqui, do jeito que estava.
    assunto         text,
    corpo_inicio    text,
    tipo_motor      text,
    tipo_correto    text NOT NULL,
    -- Obrigatório. Uma correção sem motivo não ensina nada: daqui a um mês
    -- ninguém sabe se foi regra ou exceção daquele caso.
    motivo          text NOT NULL,
    autor_id        uuid REFERENCES usuarios(id),
    criado_em       timestamptz NOT NULL DEFAULT now(),
    -- Preenchido pelo motor, que é onde as regras moram: o classificador ATUAL
    -- acerta esta evidência? É o placar do aprendizado.
    acerta_agora    boolean,
    medido_em       timestamptz
);

CREATE INDEX IF NOT EXISTS ix_reclass_conversa
    ON licitacao_reclassificacoes(conversation_id);
CREATE INDEX IF NOT EXISTS ix_reclass_data
    ON licitacao_reclassificacoes(criado_em DESC);

COMMENT ON TABLE licitacao_reclassificacoes IS
    'Correções humanas de tipo, com a evidência congelada e o motivo. Serve como '
    'conjunto de testes do classificador: o motor mede acerta_agora a cada '
    'rodada, então mudar uma regra mostra na hora o que melhorou e o que quebrou.';
COMMENT ON COLUMN licitacao_entrada.tipo_manual IS
    'Tipo decidido por gente. Vence o `tipo` do motor na tela e nos números. A '
    'sincronização NUNCA escreve nesta coluna.';
