-- v36 · Os contratos de venda do D365, para achar o cliente da solicitação
--
-- A caixa de entrada precisa saber de qual cliente é cada solicitação: a demanda
-- exige cliente, e sem ele o pedido não pode virar trabalho. Até agora as chaves
-- eram o CNPJ lido no anexo (via de-para de órgãos) e a nota de empenho que já
-- tinha demanda — juntas, 31 dos 214 casos.
--
-- O Tassio trouxe um export do D365 com os 303 contratos de venda, e ele tem uma
-- chave melhor: o e-mail da licitação quase sempre cita o contrato MSB
-- ("MSB-000238"), e o contrato aponta o código do cliente. Medido: resolve 81
-- casos a mais, levando a 113 de 214. É a chave que mais rende, à frente do CNPJ.
--
-- O título do contrato ainda carrega o pregão ("PE 90124/2025 DIVERSOS"), o que
-- dá um segundo caminho — e serve para preencher `numero_pregao` nas demandas,
-- vazio em 95 delas hoje, o que quebra o vínculo com saldo de contrato.
--
-- Por que uma tabela e não a planilha lida na hora: contrato novo aparece toda
-- semana, e um arquivo em Downloads não é fonte de dado para um app em produção.
-- O motor reimporta sozinho o export que estiver em `Licitacao/D365/`.
CREATE TABLE IF NOT EXISTS licitacao_contratos_d365 (
    -- O próprio ID do contrato de venda do D365 é a chave: é assim que o órgão
    -- e o time se referem a ele, e é o que vem escrito no e-mail.
    contrato        text PRIMARY KEY,
    -- Código do cliente no D365 (C003052). 302 dos 303 existem em `clientes`.
    codigo_cliente  text NOT NULL,
    -- Resolvido na importação, pelo código. Fica nulo quando o código não
    -- existe no cadastro — visível em vez de silenciosamente perdido.
    cliente_id      uuid REFERENCES clientes(id),
    nome_d365       text,
    -- "PE 90124/2025 DIVERSOS" — é daqui que sai o pregão.
    titulo          text,
    pregao          text,
    -- Efetivo | Em Espera. Contrato em espera continua servindo para identificar
    -- o cliente de um e-mail antigo, então não é filtrado na resolução.
    status          text,
    importado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_contratos_d365_cliente ON licitacao_contratos_d365(cliente_id);
-- A resolução por pregão só vale quando ele aponta um cliente único; o índice
-- serve à checagem dessa unicidade.
CREATE INDEX IF NOT EXISTS ix_contratos_d365_pregao ON licitacao_contratos_d365(pregao);

COMMENT ON TABLE licitacao_contratos_d365 IS
    'Contratos de venda exportados do D365. Usados para achar o cliente de uma '
    'solicitação pelo contrato MSB citado no e-mail, ou pelo pregão do anexo.';
