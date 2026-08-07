-- v30 · Permitir realocar uma OV em pallet depois de já ter sido coletada
--
-- `pallet_pedidos` tinha UNIQUE em pedido_id (pallet_pedidos_pedido_id_key), o que
-- dava "um vínculo por OV para sempre". Isso briga com duas coisas que o próprio
-- app faz:
--
--   1. a coleta NÃO apaga o vínculo — marca status COLETADO para manter histórico
--      (ver confirmar_coleta_pallet em inventario_service.py);
--   2. uma OV pode voltar para o pallet — foi o caso da OV016168: faturada por
--      engano com a nota de outra OV, coletada, e depois refaturada com a nota
--      real (20307). Ela precisava ir para o pallet de novo e o banco recusava.
--
-- Com as duas juntas, toda OV já coletada ficava impedida de voltar a um pallet.
-- No momento desta migration isso alcançava 304 das 310 OVs com histórico.
--
-- A regra correta não é "uma OV, um vínculo": é "uma OV não pode estar em DOIS
-- pallets esperando coleta ao mesmo tempo". Vínculo COLETADO é embarque passado e
-- CANCELADO foi desfeito — nenhum dos dois ocupa lugar. Isso é exatamente um
-- índice único PARCIAL.
--
-- Conferido antes de rodar: nenhuma OV tem hoje mais de um vínculo AGUARDANDO
-- (310 vínculos: 303 COLETADO, 6 AGUARDANDO, 1 CANCELADO), então o índice novo
-- não encontra violação.

ALTER TABLE pallet_pedidos
    DROP CONSTRAINT IF EXISTS pallet_pedidos_pedido_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pallet_pedidos_aguardando
    ON pallet_pedidos (pedido_id)
    WHERE status = 'AGUARDANDO';

-- O app passa a gravar o status explicitamente no insert; o default cobre linhas
-- antigas e qualquer inserção feita fora do app.
ALTER TABLE pallet_pedidos
    ALTER COLUMN status SET DEFAULT 'AGUARDANDO';

COMMENT ON INDEX uq_pallet_pedidos_aguardando IS
    'Uma OV em no máximo um pallet AGUARDANDO coleta. Vínculos COLETADO/CANCELADO '
    'são histórico e podem se repetir — é o que permite realocar uma OV refaturada.';
