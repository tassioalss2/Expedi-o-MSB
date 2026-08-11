-- Condição de pagamento da OV — texto livre, digitado pelo operador.
-- Livre de propósito: a condição vem negociada caso a caso (ex.: "30 dias",
-- "28/56/84", "à vista", "empenho — 30 dias após liquidação") e uma lista fixa
-- ficaria desatualizada. Mesmo formato já usado em crm_cotacoes.condicao_pagamento.
alter table pedidos add column if not exists condicao_pagamento text;

-- Fica nulo nas OVs antigas: são registros anteriores à exigência e não dá para
-- inventar a condição delas. O campo só passa a ser obrigatório nas novas.
