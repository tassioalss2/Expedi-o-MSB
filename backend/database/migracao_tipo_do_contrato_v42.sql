-- v42 · O tipo de venda vem do CONTRATO, não da palavra no assunto
--
-- O Tássio trouxe um export do D365 com a coluna
-- `SalesPurchOperationType_BR_InoveProjects`, que diz o tipo de venda do
-- contrato: S.LIC.002 é venda direta, S.LIC.003 é consignação. É dado
-- cadastrado por quem assinou o contrato — sinal muito mais forte do que
-- adivinhar pelo texto do e-mail, que é o que o motor fazia.
--
-- Medido antes de aplicar, nos 197 casos:
--
--     casos que citam contrato ............ 120
--     contrato encontrado no export ....... 118  (2 fora: MSB-000273, MSB-000303)
--     já coerentes com o contrato ......... 113
--     a corrigir ..........................   5
--
-- Entre os 5, dois são o caso que o Tássio corrigiu à mão ontem (contrato
-- MSB-000238, que é S.LIC.003) — ou seja, o contrato explicava sozinho, sem
-- heurística de texto nenhuma. Outros dois vão no sentido oposto: casos que a
-- regra de texto tinha mandado para consignação e cujo contrato é venda direta.
--
-- Um detalhe do processo que o Tássio explicou e que a regra respeita:
-- consignação FATURA por comunicado de uso. Então um contrato S.LIC.003 não
-- afirma "este e-mail é reposição"; ele descarta venda direta. Comunicado de uso
-- num contrato de consignação continua comunicado de uso.
ALTER TABLE licitacao_contratos_d365
    ADD COLUMN IF NOT EXISTS tipo_operacao text;

COMMENT ON COLUMN licitacao_contratos_d365.tipo_operacao IS
    'SalesPurchOperationType do D365: S.LIC.002 = venda direta, S.LIC.003 = '
    'consignação. Usado para corrigir o tipo deduzido do texto do e-mail — mas '
    'nunca a correção feita à mão, que continua vencendo tudo.';
