update licitacao_demandas
set etapa = 'OV_GERADA', concluido_em = null
where tipo_operacao in ('VENDA_DIRETA', 'CONSIGNACAO')
  and etapa = 'CONCLUIDO'
  and gerado_tipo = 'PEDIDO';
