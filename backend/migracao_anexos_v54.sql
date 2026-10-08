-- v54 — Documentos anexados à OV
--
-- A OV nasce de um documento: a nota de empenho, a ordem de compra, a
-- autorização de fornecimento, o comprovante de pagamento antecipado, a carta
-- com a exigência de faturamento do órgão. Hoje esse papel fica no e-mail de
-- quem abriu a OV, e quando outra pessoa pega o caso — expedição, faturamento,
-- a operadora que entrou no lugar de quem saiu — ela não tem como ver o que o
-- cliente pediu. Já aconteceu de a NF sair sem o que o órgão exigia.
--
-- O ARQUIVO não vive aqui: vive no bucket privado `anexos-ov` do Storage. Esta
-- tabela guarda só o ponteiro e quem subiu — linha de banco com megabytes de
-- PDF dentro trava consulta que não tem nada a ver com anexo.
--
-- ON DELETE CASCADE: OV cancelada e removida leva os anexos junto; deixar
-- registro órfão apontando para arquivo que ninguém mais acha não ajuda nada.

CREATE TABLE IF NOT EXISTS pedido_anexos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id   UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    nome        TEXT NOT NULL,           -- como o arquivo se chamava na máquina de quem subiu
    caminho     TEXT NOT NULL,           -- caminho dentro do bucket anexos-ov
    tipo        TEXT,                    -- content-type declarado no upload
    tamanho     BIGINT,                  -- bytes
    descricao   TEXT,                    -- o que é este documento, escrito por quem anexou
    criado_por  UUID REFERENCES usuarios(id),
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedido_anexos_pedido ON pedido_anexos (pedido_id, criado_em DESC);

-- O bucket `anexos-ov` já foi criado (privado, teto de 20 MB por arquivo). O
-- acesso é sempre pelo backend com a service key, que devolve uma URL assinada
-- de curta duração — nenhum arquivo fica com link público.
