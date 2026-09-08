-- v39 · A conversa inteira, e não só o e-mail que a licitação repassou
--
-- O motor sempre leu apenas mensagens cujo remetente é licitacao@msbbrasil.com,
-- porque é a licitação que recebe a solicitação do cliente e repassa. Só que a
-- licitação repassa e SAI da conversa: a tratativa é nossa, tem outro
-- remetente, e por isso nunca entrava no app.
--
-- Medido no Outlook, janela de 01/07 a 08/09/2026:
--
--     mensagens que o motor via ...............  253
--     mensagens que nunca viu .................  399   (61% da conversa)
--       dessas, respostas nossas ..............   34
--     conversas distintas .....................  192   (contra 253 e-mails)
--     conversas com resposta nossa ............  112 de 192
--     conversas com uma mensagem só ...........   67
--
-- Quem abria um caso no app lia um pedaço da conversa e não entendia o resto.
-- Foi o Tássio quem apontou a causa: "o e-mail da licitação não entra mais na
-- conversa, por isso às vezes tá me confundindo".
--
-- As mensagens vão para tabela PRÓPRIA, não para uma coluna de licitacao_entrada.
-- A listagem da caixa de entrada faz `select *` sobre 253 registros e já carrega
-- ~1 MB de corpos; as threads somam 3,5 MB e quadruplicariam toda listagem, para
-- um conteúdo que só é lido quando alguém abre UM caso. Em tabela separada a
-- lista continua leve e a conversa é buscada sob demanda.
CREATE TABLE IF NOT EXISTS licitacao_mensagens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- O ConversationID do Outlook. É o que costura mensagens que estão em
    -- pastas diferentes (Caixa de Entrada, Itens Enviados, Finalizados).
    conversation_id text NOT NULL,
    -- EntryID longo (140 chars), não o curto que a tabela de conversa devolve
    -- (48): só o longo é estável e é o que o protocolo `ace-email:` abre.
    entry_id        text NOT NULL UNIQUE,
    enviado_em      timestamptz,
    de              text,
    nome            text,
    -- LICITACAO / MSB / EXTERNO. A licitação é separada da MSB de propósito:
    -- ela repassa, nós tratamos, e é essa diferença que diz se alguém já pegou
    -- o caso. Remetente interno chega como caminho X500 (sem "@"), então a
    -- ausência de arroba é o que denuncia que é de dentro.
    papel           text,
    assunto         text,
    corpo           text,
    pasta           text,
    criado_em       timestamptz NOT NULL DEFAULT now()
);

-- A leitura é sempre "as mensagens desta conversa, em ordem de tempo".
CREATE INDEX IF NOT EXISTS ix_licitacao_msgs_conversa
    ON licitacao_mensagens(conversation_id, enviado_em);

-- Na entrada ficam só o ponteiro e o RESUMO da conversa. O resumo existe para a
-- listagem poder mostrar "respondido por Maiara em 30/07" sem carregar 3,5 MB.
ALTER TABLE licitacao_entrada
    ADD COLUMN IF NOT EXISTS conversation_id text,
    ADD COLUMN IF NOT EXISTS msgs_total      integer NOT NULL DEFAULT 0,
    -- Quando alguém da MSB (não a licitação) falou na conversa por último.
    ADD COLUMN IF NOT EXISTS respondido_em   timestamptz,
    ADD COLUMN IF NOT EXISTS respondido_por  text,
    -- A última mensagem de qualquer um: é ela que diz se o caso está morto ou
    -- se mexeu ontem. "Parado há 30 dias" contado pela data do e-mail da
    -- licitação mentia sempre que a conversa continuou sem ela.
    ADD COLUMN IF NOT EXISTS ultima_msg_em   timestamptz;

CREATE INDEX IF NOT EXISTS ix_licitacao_entrada_conversa
    ON licitacao_entrada(conversation_id);

COMMENT ON TABLE licitacao_mensagens IS
    'Mensagens da conversa do Outlook, inclusive as que não passaram pela caixa '
    'da licitação (respostas nossas e do órgão). Chave: conversation_id.';
COMMENT ON COLUMN licitacao_entrada.respondido_em IS
    'Última fala de alguém da MSB na conversa. É sinal, não decisão: quem define '
    'se o caso está em tratativa é a pessoa, no campo em_tratativa.';
