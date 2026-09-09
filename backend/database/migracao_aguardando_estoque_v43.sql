-- v43 · "Aguardando estoque" como estado do caso, marcado por gente
--
-- Pedido do Tássio: uma coluna para as entregas parciais e outra para as
-- solicitações em que estamos aguardando estoque.
--
-- A parcial já existia: é `situacao = 'PARCIAL'`, e são 6 casos abertos hoje.
-- Ela só não tinha coluna própria — ficava misturada no "A fazer" com os
-- intocados, que é justamente o que esconde trabalho de outra natureza.
--
-- "Aguardando estoque" NÃO existia em lugar nenhum, e isto foi medido antes de
-- criar coluna: nenhuma das 204 demandas ativas está numa etapa de espera por
-- estoque (as etapas em uso são NF_ENVIADA, CONCLUIDO, PROCESSANDO, RECEBIDO e
-- OV_GERADA), e apenas 3 dos 137 casos abertos têm demanda — todos os três já
-- com nota fiscal. Ou seja: não há de onde deduzir, porque quem sabe que falta
-- material é quem está triando, antes de existir demanda.
--
-- Por isso é marca humana, e não dedução. E é coerente com uma decisão que o
-- Tássio já tinha tomado em 04/09: NÃO mostrar saldo de estoque na caixa de
-- entrada, porque naquela fase o pedido ainda não é compromisso e ver saldo
-- antes de existir demanda faz alguém reservar material de cabeça. Marcar "está
-- faltando" é diferente de exibir quanto tem.
ALTER TABLE licitacao_entrada
    ADD COLUMN IF NOT EXISTS aguardando_estoque boolean NOT NULL DEFAULT false,
    -- Quem marcou e quando: um caso parado por falta de material fica parado
    -- por semanas, e a tela precisa dizer a quem perguntar.
    ADD COLUMN IF NOT EXISTS estoque_por        uuid REFERENCES usuarios(id),
    ADD COLUMN IF NOT EXISTS estoque_em         timestamptz,
    -- O que falta, em texto. Não é lista de itens de propósito: quem marca está
    -- no meio da triagem e escreve "falta o 6F", não vai preencher formulário.
    ADD COLUMN IF NOT EXISTS estoque_obs        text;

COMMENT ON COLUMN licitacao_entrada.aguardando_estoque IS
    'Marcado por gente: o caso está parado por falta de material. A '
    'sincronização NUNCA escreve nesta coluna. Não é deduzido de saldo — ver a '
    'decisão de não mostrar estoque na caixa de entrada.';
