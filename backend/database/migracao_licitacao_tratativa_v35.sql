-- v35 · "Estou tratando disso" na caixa de entrada da licitação
--
-- A caixa de entrada já tem três situações — em aberto, parcial, resolvido —,
-- mas elas respondem "o pedido foi atendido?". Falta responder outra coisa,
-- pedida pelo Tassio: "alguém já pegou este caso?".
--
-- São eixos diferentes e um não substitui o outro. Uma venda direta que ele já
-- começou a tratar, mas que ainda não entregou nada, continua EM ABERTO — e
-- marcá-la como PARCIAL para sinalizar que está sendo cuidada seria mentir
-- sobre o atendimento, que é justamente o número que o conselho acompanha.
-- Por isso é uma coluna própria, e não uma quarta situação.
--
-- Fica compartilhada, não por usuário. O pedido nasceu de organização pessoal,
-- mas o ganho maior é o time inteiro ver que um caso já tem dono informal antes
-- de mexer nele — o mesmo motivo de existir a ligação entrada→demanda: evitar
-- duas pessoas trabalhando o mesmo pedido.
ALTER TABLE licitacao_entrada
    ADD COLUMN IF NOT EXISTS em_tratativa boolean NOT NULL DEFAULT false,
    -- Quem marcou e quando. Sem isso a marca vira anônima e ninguém sabe a
    -- quem perguntar sobre um caso que está "sendo tratado" há duas semanas.
    ADD COLUMN IF NOT EXISTS tratativa_por uuid REFERENCES usuarios(id),
    ADD COLUMN IF NOT EXISTS tratativa_em timestamptz;

-- O filtro da tela abre por aqui, junto com a situação.
CREATE INDEX IF NOT EXISTS ix_licitacao_entrada_tratativa
    ON licitacao_entrada(em_tratativa) WHERE ativo AND em_tratativa;

COMMENT ON COLUMN licitacao_entrada.em_tratativa IS
    'Alguém assumiu o caso e está tratando. Independente da situação: um caso '
    'em tratativa continua "em aberto" até ser atendido.';
