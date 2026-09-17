-- v49 — Registro de qual mensagem já foi enviada ao cliente/transportadora
--
-- O app monta três textos: a cotação de frete (CIF, vai por WhatsApp), o
-- pedido de transportadora (FOB, vai por e-mail) e o aviso de saldo pendente
-- que segue com a NF. Montar não é enviar — quem envia é a pessoa, do Outlook
-- ou do WhatsApp, e até aqui não havia como saber o que já tinha saído.
--
-- Um jsonb e não três colunas booleanas: o formato aguenta a quarta mensagem
-- sem nova migração, e guarda QUANDO e POR QUEM, que é o que responde "isso
-- já foi?" numa segunda-feira de manhã.
--
--   {"cotacao_cif":  {"em": "2026-09-17T12:00:00+00:00", "por": "<uuid>", "nome": "Tássio"},
--    "coleta_fob":   {...},
--    "pendencia_nf": {...}}

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS avisos_enviados jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN pedidos.avisos_enviados IS
  'Quais mensagens do app já foram enviadas, com data e autor. Chaves: cotacao_cif, coleta_fob, pendencia_nf.';
