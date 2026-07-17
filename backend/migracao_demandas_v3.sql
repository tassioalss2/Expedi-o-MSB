alter table licitacao_demandas add column if not exists ovs jsonb default '[]'::jsonb;
update licitacao_demandas
  set ovs = jsonb_build_array(jsonb_build_object('id', gerado_id::text, 'numero', gerado_ref))
  where gerado_tipo = 'PEDIDO' and gerado_id is not null
    and (ovs is null or ovs = '[]'::jsonb);
