-- v44 · Separar "quem resolve" de "quem só informa"
--
-- Dito pelo Tássio em 09/09/2026: só três pessoas resolvem solicitação de
-- licitação — ele, Jaqueline e Emanoela. O resto do time que responde na
-- conversa está informando, não assumindo o caso.
--
-- Isso corrige a dedução de "em tratamento" que a v41 criou. Ela marcava o caso
-- quando QUALQUER pessoa da MSB falava na conversa, e medindo em 09/09 isso
-- dava 45 casos — dos quais 8 vinham de quem não resolve (Drielly, Ana, Laisa,
-- Maiara, Gabriele, Mirailton). Oito casos apareciam como "sendo tratados" sem
-- ninguém estar com eles, o que é pior do que não deduzir nada: some da fila de
-- quem procura trabalho para fazer.
--
-- A coluna nova guarda o outro fato, que continua valendo a pena mostrar: houve
-- resposta nossa, de alguém que informa. Sem ela, o card só poderia dizer
-- "ninguém respondeu" — e diria isso sobre um caso em que a Maiara respondeu ao
-- órgão, o que é falso e faz duvidar do resto da tela.
--
--     respondido_em / respondido_por   última fala de QUEM RESOLVE  -> em tratamento
--     informado_em  / informado_por    última fala de quem só informa
ALTER TABLE licitacao_entrada
    ADD COLUMN IF NOT EXISTS informado_em  timestamptz,
    ADD COLUMN IF NOT EXISTS informado_por text;

COMMENT ON COLUMN licitacao_entrada.respondido_em IS
    'Última fala de quem RESOLVE licitação (Tássio, Jaqueline, Emanoela) na '
    'conversa. É sinal, não decisão: quem define se o caso está em tratativa é a '
    'pessoa, no campo tratativa_manual.';
COMMENT ON COLUMN licitacao_entrada.informado_por IS
    'Última fala de alguém da MSB que NÃO resolve licitação — resposta de '
    'informação. Não marca o caso como em tratamento.';
