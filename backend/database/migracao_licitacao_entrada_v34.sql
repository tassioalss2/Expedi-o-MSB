-- v34 · A caixa de entrada da licitação sai do Excel e entra no app
--
-- Hoje a triagem das solicitações que chegam por e-mail vive numa planilha
-- (Licitacao_Solicitacoes.xlsx), gerada duas vezes por dia por um motor que lê
-- o Outlook. O time marca "Feito? Sim/Nao" e escreve observações ali. Isso
-- funciona, mas tem três limites que não se resolvem em Excel:
--
--   1. É invisível para quem não abre o arquivo. O conselho quer acompanhar, e
--      não há como acompanhar uma planilha na máquina de uma pessoa.
--   2. Não conversa com o resto do processo. O painel de demandas do app já
--      modela RECEBIDO → ... → NF_ENVIADA, e a mesma nota de empenho aparece
--      nos dois lugares — a 2026NE001167 está na planilha E como demanda. Dois
--      registros do mesmo trabalho, sem ligação.
--   3. Não tem estado intermediário. Na triagem de 03/09/2026 o time escreveu
--      "Parcial" à mão em 3 das 218 linhas, num campo que só oferecia Sim/Nao.
--      O processo tem esse estado; a ferramenta é que não tinha.
--
-- Esta migração cria as duas tabelas que faltam para o app assumir. A planilha
-- continua sendo gerada em paralelo por algumas semanas: se a ingestão falhar,
-- o processo não pode parar.

-- ── licitacao_orgaos ────────────────────────────────────────────────────────
-- O de-para entre o órgão público que aparece no documento e o cliente do
-- cadastro. Existe porque não há como deduzir isso com segurança:
--
--   · Dos 3.853 clientes do cadastro, 48 têm CNPJ preenchido — e nenhum dos
--     hospitais de licitação está entre eles. Casar por CNPJ direto no cadastro
--     não funciona.
--   · Casar por semelhança de nome erra feio. Testado nos anexos reais:
--     acertou "HOSPITAL DAS CLÍNICAS DA FACULDADE DE MEDICINA" (0,80), mas
--     ligou "HOSPITAL UNIVERSITÁRIO LAURO WANDERLEY" a uma pessoa física
--     chamada Wanderley. Adivinhar cliente errado é pior que não criar nada.
--
-- O que salva é o tamanho do universo: são 37 nomes de órgão distintos em toda
-- a licitação. É uma tabela que alguém preenche uma vez, confirmando cada um, e
-- a partir daí a ingestão é automática — o CNPJ vem no anexo e é chave exata.
CREATE TABLE IF NOT EXISTS licitacao_orgaos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Só dígitos, 14 posições. Normalizar aqui evita que o mesmo órgão entre
    -- duas vezes por causa de ponto e barra.
    cnpj            text NOT NULL UNIQUE CHECK (cnpj ~ '^[0-9]{14}$'),
    -- Como o documento do órgão se chama. Guardado para quem confirma poder
    -- reconhecer o que está confirmando, e para achar o de-para pelo nome
    -- quando o anexo vier escaneado e sem CNPJ legível.
    nome_documento  text,
    cliente_id      uuid NOT NULL REFERENCES clientes(id),
    -- Quem confirmou. Este de-para decide de quem é a venda; se estiver errado,
    -- é preciso saber a quem perguntar.
    confirmado_por  uuid REFERENCES usuarios(id),
    criado_em       timestamptz NOT NULL DEFAULT now(),
    atualizado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_licitacao_orgaos_cliente ON licitacao_orgaos(cliente_id);

COMMENT ON TABLE licitacao_orgaos IS
    'De-para CNPJ do órgão público → cliente do cadastro. Preenchido pela tela '
    'de órgãos; é o que permite a ingestão automática dos e-mails de licitação.';

-- ── licitacao_entrada ───────────────────────────────────────────────────────
-- Uma linha por E-MAIL, não por nota de empenho. A planilha agrupa por NE na
-- apresentação (uma NE gerou 5 e-mails e virava 5 linhas, o que fazia perder o
-- fio), mas o registro tem de ser o e-mail: é ele que tem data, hora, pasta e
-- texto próprios, e é o histórico dele que o time quer ver. O agrupamento
-- acontece na tela, sobre a coluna `empenhos`.
CREATE TABLE IF NOT EXISTS licitacao_entrada (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- A identidade que o motor calcula para o e-mail. UNIQUE é o que torna a
    -- sincronização idempotente: o motor roda 2x por dia sobre uma janela que
    -- se repete quase inteira, e sem isto cada rodada duplicaria tudo.
    chave           text NOT NULL UNIQUE,
    recebido_em     timestamptz NOT NULL,
    pasta           text,
    assunto         text NOT NULL,
    corpo           text,
    -- Classificação do motor. Os mesmos valores do painel de demandas, mais
    -- OUTRO: o motor não força um tipo quando o e-mail não diz qual é.
    tipo            text CHECK (tipo IN ('VENDA_DIRETA','CONSIGNACAO','COMUNICADO_USO','AMOSTRA','OUTRO')),
    -- 1 crítica … 5 informativa, como na planilha.
    prioridade      smallint NOT NULL DEFAULT 5 CHECK (prioridade BETWEEN 1 AND 5),
    motivo          text,
    -- Um e-mail pode citar mais de uma NE. Caso real: "2026NE001167 /
    -- 2026NE01167", que ainda por cima parece erro de digitação do órgão
    -- (falta um zero). Array porque escolher uma seria inventar.
    empenhos        text[] NOT NULL DEFAULT '{}',
    contrato        text,
    pregao          text,
    -- O que o órgão está pedindo, extraído do ANEXO — não da nota fiscal.
    -- Cada item: {descricao, codigo_msb, qtd, valor_unitario, valor_total,
    -- conta_nao_fecha, fonte}. Vazio quando o anexo é escaneado (só foto).
    itens           jsonb NOT NULL DEFAULT '[]',
    -- Metadados dos anexos lidos: nome, família, se falhou e por quê. Serve
    -- para a tela dizer "o anexo é uma foto, abra o e-mail" em vez de mostrar
    -- uma solicitação vazia sem explicação.
    anexos          jsonb NOT NULL DEFAULT '[]',
    cnpj_orgao      text,
    orgao_texto     text,
    -- Preenchido quando o de-para resolve, ou escolhido a mão na triagem.
    cliente_id      uuid REFERENCES clientes(id),
    -- A ligação com o resto do processo: quando a triagem promove a entrada, a
    -- demanda nasce e o card passa a andar no painel que já existe.
    demanda_id      uuid REFERENCES licitacao_demandas(id),
    -- PARCIAL existe porque o time precisou dele. Ver o cabeçalho.
    situacao        text NOT NULL DEFAULT 'NAO' CHECK (situacao IN ('NAO','PARCIAL','SIM')),
    observacao      text,
    -- Sugestão automática do cruzamento com o app (a coluna [ACE] da planilha)
    -- e se ela já foi vista, para não reaparecer depois de lida.
    sugestao        text,
    sugestao_lida   boolean NOT NULL DEFAULT false,
    ativo           boolean NOT NULL DEFAULT true,
    criado_em       timestamptz NOT NULL DEFAULT now(),
    atualizado_em   timestamptz NOT NULL DEFAULT now()
);

-- A tela abre filtrando o que falta fazer, e ordena por prioridade e data.
CREATE INDEX IF NOT EXISTS ix_licitacao_entrada_aberto
    ON licitacao_entrada(situacao, prioridade, recebido_em DESC) WHERE ativo;
-- Agrupar por nota de empenho é a operação central da tela.
CREATE INDEX IF NOT EXISTS ix_licitacao_entrada_empenhos
    ON licitacao_entrada USING gin(empenhos);
CREATE INDEX IF NOT EXISTS ix_licitacao_entrada_cnpj ON licitacao_entrada(cnpj_orgao);
CREATE INDEX IF NOT EXISTS ix_licitacao_entrada_demanda ON licitacao_entrada(demanda_id);

COMMENT ON TABLE licitacao_entrada IS
    'Caixa de entrada da licitação: um registro por e-mail recebido, com os '
    'itens extraídos do anexo do pedido. Substitui a planilha de triagem.';
