-- v32 · Tipo de frete próprio para comunicado de uso
--
-- Comunicado de uso é faturamento de material consignado que o cliente JÁ usou.
-- Não há coleta, não há transportadora, não há logística nenhuma: o material
-- saiu da MSB meses antes, no envio do consignado. Mesmo assim a OV nascia com
-- tipo_frete = 'FOB', porque FOB era o default e não existia nada melhor.
--
-- FOB ali é uma informação errada, não uma informação neutra: FOB significa
-- "o cliente informa a transportadora que vai coletar, e ela vai na NF". Quem
-- lê a OV de um comunicado de uso e vê FOB fica esperando um dado de coleta que
-- nunca vai existir.
--
-- 'NAO_UTILIZAR_TERCEIROS' ("Não utilizar - Frete terceiros") diz o que de fato
-- acontece: essa OV não usa frete da MSB, o transporte foi de terceiros.
--
-- ATENCAO — o UPDATE no fim reescreve o tipo_frete de comunicados de uso que JA
-- existem. E o efeito desejado (senao a mudanca so valeria para os novos), mas e
-- alteracao de dado real. O SELECT antes dele mostra quantas linhas vao mudar.
-- Rode o SELECT primeiro se quiser conferir o tamanho antes de aplicar.

-- 1. Constraint: aceitar o novo valor.
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_tipo_frete_check;

ALTER TABLE pedidos ADD CONSTRAINT pedidos_tipo_frete_check
  CHECK (tipo_frete IN ('FOB', 'CIF_COM_VALOR', 'CIF_SEM_VALOR', 'NAO_UTILIZAR_TERCEIROS'));

-- 2. Quantas linhas o UPDATE abaixo vai tocar.
SELECT count(*) AS comunicados_que_serao_ajustados
  FROM pedidos
 WHERE tipo_operacao = 'COMUNICADO_USO'
   AND tipo_frete IS DISTINCT FROM 'NAO_UTILIZAR_TERCEIROS';

-- 3. Comunicados de uso que ja existem passam a mostrar o tipo certo.
UPDATE pedidos
   SET tipo_frete = 'NAO_UTILIZAR_TERCEIROS'
 WHERE tipo_operacao = 'COMUNICADO_USO'
   AND tipo_frete IS DISTINCT FROM 'NAO_UTILIZAR_TERCEIROS';
