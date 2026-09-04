-- v38 · Abrir o e-mail original no Outlook, a partir do histórico
--
-- Pedido do Tassio: clicar no e-mail no histórico do caso e ele abrir no
-- Outlook. Hoje o histórico mostra o texto (até 1.400 caracteres) e nada mais —
-- para ver a thread inteira, os anexos ou responder, é preciso ir ao Outlook e
-- procurar pelo assunto.
--
-- O Outlook registra o esquema `outlook:<EntryID>`, que abre o item direto. O
-- EntryID já era lido pelo motor; só não era guardado.
--
-- O CUIDADO que essa coluna exige: o EntryID **muda quando o e-mail é movido de
-- pasta** — e mover de pasta é exatamente o que o time faz quando resolve um
-- assunto (é o único sinal de triagem que existe na caixa). Por isso ele NÃO é
-- a identidade do registro; a identidade continua sendo `chave`, um hash de
-- assunto + data que não se mexe. Esta coluna é só um atalho, e é reescrita a
-- cada rodada do motor — então fica no máximo meio dia desatualizada, e um link
-- que falhou volta a funcionar na rodada seguinte.
ALTER TABLE licitacao_entrada
    ADD COLUMN IF NOT EXISTS entry_id text;

COMMENT ON COLUMN licitacao_entrada.entry_id IS
    'EntryID do item no Outlook, para o link outlook:<id>. Volátil de propósito '
    '(muda ao mover de pasta) e reescrito a cada sincronização — nunca usar '
    'como identidade do registro; para isso existe `chave`.';
