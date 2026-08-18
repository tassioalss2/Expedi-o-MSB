-- v14 — A mesma separação da v13, agora no CRM.
--
-- Oportunidade e cotação também perguntavam a linha comercial no campo `canal`.
-- Quando a venda desce para a OV, os itens dizem a linha — o palpite digitado no
-- funil só podia divergir. Fica a pergunta que os itens não respondem: direta ou
-- licitação.
--
-- `canal` continua nas duas tabelas (histórico e as oportunidades sem item ainda
-- cadastrado), agora derivado dos itens em vez de digitado.

alter table crm_oportunidades add column if not exists forma_venda text;
alter table crm_cotacoes      add column if not exists forma_venda text;

update crm_oportunidades
   set forma_venda = case
       when canal like 'LICITACAO%' then 'LICITACAO'
       when canal is not null        then 'DIRETA'
       else null
   end
 where forma_venda is null;

update crm_cotacoes
   set forma_venda = case
       when canal like 'LICITACAO%' then 'LICITACAO'
       when canal is not null        then 'DIRETA'
       else null
   end
 where forma_venda is null;

create index if not exists idx_crm_opp_forma_venda on crm_oportunidades (forma_venda);
