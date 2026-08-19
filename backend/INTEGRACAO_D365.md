# Integração ACE-MSB ↔ Dynamics 365 (somente leitura)

## 1. Pedido para a TI

> **Assunto: registro de aplicativo no Entra ID para leitura do D365 (app interno ACE-MSB)**
>
> Preciso de um registro de aplicativo no Entra ID para que o nosso app interno de
> gestão comercial e logística (ACE-MSB) leia dados do Dynamics 365 Finance &
> Operations. Hoje esses dados entram por planilha exportada e digitação manual.
>
> **A integração é somente leitura.** O app não grava nada no D365.
>
> O que preciso:
>
> **1. No portal do Entra ID → Registros de aplicativo → Novo registro**
> - Nome: `ACE-MSB Integração D365 (leitura)`
> - Tipo de conta: apenas este diretório organizacional
> - Não precisa de URI de redirecionamento (é fluxo de aplicação, sem login de usuário)
>
> **2. Em Certificados e segredos → Novo segredo do cliente**
> - Validade: 24 meses (anotar a data — quando expira, a integração para)
>
> **3. Em Permissões de API → Adicionar permissão → Dynamics ERP**
> - Permissões de aplicativo: `Connector.FullAccess` (ou o equivalente disponível)
> - Depois: **Conceder consentimento do administrador**
>
> *A permissão do Entra ID é apenas o portão de entrada. O que o app pode de fato
> ler é decidido no passo 4, pela função atribuída ao usuário de serviço — e essa
> função será só de leitura.*
>
> **4. Dentro do D365** → Administração do sistema → Configurar → **Aplicativos do
> Microsoft Entra ID**
> - Adicionar uma linha com o **Client ID** do app criado
> - Vincular a um usuário de serviço (pode ser um novo, ex.: `svc-acemsb`)
> - Atribuir a esse usuário uma função **somente de leitura**
>
> **Este passo 4 é o que costuma ser esquecido.** Sem ele o Entra ID emite o token
> normalmente e o D365 responde 401 — parece problema de permissão no Entra ID,
> mas não é.
>
> **O que preciso receber de volta:**
> - Tenant ID (GUID)
> - Client ID (GUID)
> - Client secret (o valor, que só aparece uma vez)
> - URL do ambiente, no formato `https://<ambiente>.operations.dynamics.com`
>
> O secret vai direto para as variáveis de ambiente do servidor do app, sem passar
> por planilha, e-mail ou código-fonte.

## 2. Onde colocar as credenciais

**Nunca no código.** Só em variável de ambiente.

**Produção** — Render → serviço do backend → Environment:

```
D365_RESOURCE        https://<ambiente>.operations.dynamics.com
D365_TENANT_ID       <tenant>
D365_CLIENT_ID       <client id>
D365_CLIENT_SECRET   <secret>
D365_EMPRESA         msb          # opcional, dataAreaId
```

**Local** — no `backend/.env`, que já está no `.gitignore`.

Sem as quatro primeiras, a integração fica desligada e o app funciona exatamente
como hoje. Nada quebra por falta de configuração.

## 3. Conferir que funcionou

```bash
cd backend
venv/Scripts/python.exe diag_d365.py
```

O script separa os três pontos que falham, porque cada um se corrige em lugar
diferente:

| Sintoma | Onde está o problema |
|---|---|
| `configurado = false` | Falta variável de ambiente |
| `token_ok = false` | Entra ID recusou: secret expirado, tenant ou client_id errado |
| `token_ok = true`, `leitura_ok = false` | **O passo 4 não foi feito** — app não cadastrado dentro do D365 |

Passando disso, o script varre o catálogo do ambiente e mostra quais entidades
existem, com campos e amostra. É essa saída que define a carga de verdade.

Pela API, logado como ADMIN: `GET /api/v1/d365/status`.

E a lógica do cliente (token, cache, paginação, retentativa, o 401) tem teste que
roda sem D365 nenhum — o de produção é o sistema fiscal, não é lugar de descobrir
bug:

```bash
venv/Scripts/python.exe testa_d365.py
```

## 4. Por que descobrir em vez de já programar

O catálogo de entidades do F&O muda com a versão e com os módulos habilitados.
Chutar nome de entidade rende 404 que parece falta de permissão — e se perde uma
tarde procurando no lugar errado.

Por isso existem os endpoints de descoberta (`/d365/entidades`,
`/d365/entidades/{nome}/campos`, `/d365/amostra/{nome}`) e o `diag_d365.py`:
primeiro o ambiente diz o que tem, depois a gente escreve a carga.

## 5. Somente leitura, por construção

`app/services/d365_service.py` **não tem função de escrita**. Não é disciplina de
quem programa — é desenho: não existe `post` nem `patch` ali para alguém chamar
por engano. `testa_d365.py` falha se alguém adicionar (caso 14).

O D365 é o sistema fiscal. Quem lança nele é quem tem responsabilidade legal pelo
lançamento, não um app de apoio.

## 6. Ordem sugerida da carga

Por quanto cada uma resolve dos contornos que o app tem hoje:

1. **Estoque disponível** — acaba com a foto de uma vez ao dia, com o SA que virou
   PA sem ninguém ver, e com o ajuste manual sendo necessário
2. **Ordens de venda** — acaba com a operadora copiando o número da OV à mão
3. **Faturamento** — acaba com NF e valor digitados
4. **Produtos e clientes** — acaba com o cadastro mantido em paralelo

## 7. Manutenção

O **secret expira** (24 meses, no pedido acima). Quando expirar, toda leitura para
e o `diag_d365.py` mostra `token_ok = false`. Vale anotar a data em algum
calendário compartilhado — é uma falha que só aparece quando já aconteceu.
