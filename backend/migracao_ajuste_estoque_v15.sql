-- v15 — Ajuste manual do estoque, com motivo e autor.
--
-- O estoque do app é a foto do PCP menos as OVs, e isso é doutrina: saldo mutável
-- acumula desvio e não dá para auditar. O ajuste NÃO quebra isso — ele corrige a
-- FOTO, não guarda um saldo:
--
--     disponível = (PA da foto, corrigido pelo ajuste do dia) − comprometido
--
-- E vale só para a foto daquele dia (`data_ref`). Quando o PCP manda a foto
-- seguinte, o ajuste sai de cena sozinho — o PCP volta a ser a fonte da verdade,
-- que é o que evita a correção de hoje virar mentira permanente.
--
-- Existe porque a divergência é real: o PCP fotografa de manhã, o material chega
-- durante o dia, e a OV não pode ficar parada esperando a foto de amanhã.

create table if not exists estoque_ajustes (
    id           uuid primary key default gen_random_uuid(),
    codigo       text not null,
    data_ref     date not null,
    estoque_pa   numeric not null,          -- a quantidade REAL conferida na prateleira
    pa_anterior  numeric,                   -- o que a foto do PCP dizia, para comparar
    motivo       text not null,             -- obrigatório: ajuste sem motivo não se audita
    usuario_id   uuid references usuarios(id),
    criado_em    timestamptz not null default now()
);

-- Um ajuste por código por dia: o mais recente manda. O índice serve as duas
-- leituras que existem (o do dia, e o histórico de um código).
create index if not exists idx_estoque_ajustes_dia on estoque_ajustes (data_ref, codigo);
create index if not exists idx_estoque_ajustes_codigo on estoque_ajustes (codigo, criado_em desc);
