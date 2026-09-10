-- v46 · A nota fiscal que quem resolve citou NA RESPOSTA
--
-- O Tássio mandou o e-mail da AF 39: a Jaqueline responde em 02/09 pedindo
-- "confirmar o recebimento da nota fiscal de venda 20644", com a NF de
-- devolução (20635) e a de remessa consignado (18820) também. O caso estava
-- tratado, e o app mostrava "Em aberto".
--
-- O selo "nota já emitida" que nasceu hoje procura NF no corpo dos e-mails da
-- CAIXA. A resposta dela não está lá — está na conversa (`licitacao_mensagens`,
-- v39). Medido em 10/09/2026: olhando a conversa, 96 casos ganham o selo, e
-- 50 deles estão em aberto. Quase todos "HUC - AUTORIZAÇÃO DE FATURAMENTO
-- BIOMEDICAL - AF nn" com a Jaqueline citando a nota.
--
-- POR QUE UMA COLUNA, e não calcular na listagem: os corpos da conversa somam
-- 5,4 MB (1.065 mensagens). A listagem roda a cada refresh da tela; a
-- sincronização roda de hora em hora e já tem esses corpos em mãos. É a mesma
-- decisão da v39, que guardou `respondido_em`/`msgs_total` na entrada em vez de
-- carregar a thread para listar.
--
-- É SINAL, não decisão. A nota citada pode ser de outra remessa do mesmo
-- empenho, e em carta de correção a nota é o próprio assunto do trabalho — dos
-- 44 casos com o selo hoje, 8 são exatamente isso. Quem resolve continua sendo
-- a pessoa, no botão.
ALTER TABLE licitacao_entrada
    ADD COLUMN IF NOT EXISTS nf_citada jsonb;

COMMENT ON COLUMN licitacao_entrada.nf_citada IS
    'Notas fiscais citadas na CONVERSA que existem em `pedidos`, como '
    '[{numero, ov, por, quando}]. Preenchido na sincronização, onde os corpos '
    'da thread já estão carregados. Indício de caso encerrado, nunca decisão: '
    'carta de correção cita a nota porque o trabalho é sobre ela.';
