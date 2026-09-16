-- v48 — Endereço de entrega completo, para a cotação de frete
--
-- A transportadora não cota frete com "Belo Horizonte/MG": ela precisa do
-- logradouro, do número e do CEP. Hoje esse endereço é copiado do D365 à mão a
-- cada cotação, e o app só guarda cidade/UF em `pedidos.local_entrega` — que
-- continua existindo e continua sendo cidade/UF, porque é o que as telas e os
-- filtros usam.
--
-- São duas colunas de propósito:
--
--   pedidos.endereco_entrega   o endereço DESTA entrega (pode ser diferente:
--                              filial, obra, outro hospital da rede)
--   clientes.endereco_entrega  o último endereço usado para este cliente, para
--                              a próxima OV vir preenchida e ninguém copiar do
--                              D365 duas vezes
--
-- Nada é inventado: quem preenche é quem cola do D365, e enquanto estiver vazio
-- a mensagem de cotação sai avisando que falta o endereço.

ALTER TABLE pedidos  ADD COLUMN IF NOT EXISTS endereco_entrega text;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS endereco_entrega text;

COMMENT ON COLUMN pedidos.endereco_entrega IS
  'Endereço completo de entrega desta OV, copiado do D365. cidade/UF continua em local_entrega.';
COMMENT ON COLUMN clientes.endereco_entrega IS
  'Último endereço de entrega usado para este cliente — prefill da próxima OV.';
