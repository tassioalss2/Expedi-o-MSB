"""Integração com o Dynamics 365 Finance & Operations, via OData.

POR QUE EXISTE
--------------
Hoje o app conhece o D365 de segunda mão: a foto de estoque do PCP (uma vez ao
dia) e o que alguém digita ou exporta em planilha. Metade dos problemas que o app
contorna nasce daí — o SA que virou PA no meio do dia, o comprometido que só
fecha na manhã seguinte, o número real da OV que a operadora precisa copiar à mão.

Lendo o D365 direto, esses contornos deixam de ser necessários.

SÓ LEITURA, POR CONSTRUÇÃO
--------------------------
Este módulo não tem função de escrita. Não é disciplina, é desenho: não existe
`post` nem `patch` aqui para alguém chamar por engano. O D365 é o sistema
fiscal — quem escreve nele é quem tem responsabilidade legal pelo lançamento,
não um app de apoio.

Se um dia houver motivo para escrever, será em módulo separado, com decisão
explícita de quem manda no processo.

AUTENTICAÇÃO
------------
OAuth2 client credentials no Entra ID (antigo Azure AD): o app tem identidade
própria, não usa a conta de ninguém. Duas coisas precisam estar feitas, e a
segunda é a que todo mundo esquece:

  1. App registrado no Entra ID, com um secret;
  2. O mesmo Client ID cadastrado DENTRO do D365, em
     Administração do sistema > Configurar > Aplicativos do Microsoft Entra ID,
     vinculado a um usuário de serviço com uma função de leitura.

Sem o passo 2, o token sai do Entra ID normalmente e o D365 responde 401 — é o
erro mais comum e o mais confuso, porque o token "está certo".

CONFIGURAÇÃO (Render → Environment, ou .env local)
--------------------------------------------------
Sem as quatro primeiras a integração fica desligada e o app segue como antes:

    D365_RESOURCE        https://<ambiente>.operations.dynamics.com   (sem barra no fim)
    D365_TENANT_ID       o GUID do tenant
    D365_CLIENT_ID       o GUID do app registrado
    D365_CLIENT_SECRET   o secret do app
    D365_EMPRESA         opcional: dataAreaId (ex.: "msb"), para filtrar a empresa

Precisam estar declaradas em app/core/config.py: o Settings recusa variável
extra, então configurar no ambiente sem declarar lá derruba o boot do backend.
"""
import time
from typing import Optional
from xml.etree import ElementTree

import requests

from app.core.config import settings

_TIMEOUT = 30

# Token do Entra ID vale 1h. Renova com folga: uma requisição que sai com token
# expirando no caminho volta 401 e o erro parece ser de permissão.
_MARGEM_SEGUNDOS = 300
_token_cache: dict = {"valor": None, "expira_em": 0.0}

# 429 e 5xx do D365 são quase sempre passageiros (throttling ou reciclagem do
# ambiente). Tentar de novo com espera crescente evita transformar soluço em
# erro na tela.
_TENTATIVAS = 3
_ESPERA_BASE = 2

# Teto de páginas por consulta. O OData pagina de 10.000 em 10.000; sem teto, um
# filtro esquecido varreria a base inteira e derrubaria o dyno por memória.
_MAX_PAGINAS = 20


class D365Indisponivel(Exception):
    """Falha ao falar com o D365. Quem chama decide se degrada ou propaga."""


def _config() -> tuple:
    r = (settings.d365_resource or "").strip().rstrip("/")
    t = (settings.d365_tenant_id or "").strip()
    c = (settings.d365_client_id or "").strip()
    s = (settings.d365_client_secret or "").strip()
    return (r, t, c, s) if (r and t and c and s) else (None, None, None, None)


def integracao_ativa() -> bool:
    return _config()[0] is not None


def empresa() -> Optional[str]:
    return (settings.d365_empresa or "").strip() or None


def _token() -> str:
    """Token de aplicação, em cache até perto de expirar."""
    agora = time.monotonic()
    if _token_cache["valor"] and agora < _token_cache["expira_em"]:
        return _token_cache["valor"]

    recurso, tenant, client_id, secret = _config()
    if not recurso:
        raise D365Indisponivel("Integração com o D365 não está configurada.")

    try:
        resp = requests.post(
            f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": secret,
                # `.default` = as permissões que já foram concedidas ao app no
                # consentimento. Pedir escopo item a item aqui não funciona no
                # fluxo de aplicação.
                "scope": f"{recurso}/.default",
            },
            timeout=_TIMEOUT,
        )
    except requests.RequestException as e:
        raise D365Indisponivel(f"Não foi possível falar com o Entra ID: {e}")

    if resp.status_code != 200:
        # A resposta de erro do Entra ID traz `error_description`, que é o que
        # de fato explica (secret expirado, tenant errado, app inexistente).
        # NÃO logamos o corpo inteiro: o request de ida leva o secret.
        try:
            detalhe = resp.json().get("error_description", "")[:300]
        except Exception:
            detalhe = ""
        raise D365Indisponivel(f"Entra ID recusou a autenticação ({resp.status_code}). {detalhe}")

    dados = resp.json()
    _token_cache["valor"] = dados["access_token"]
    _token_cache["expira_em"] = agora + float(dados.get("expires_in", 3600)) - _MARGEM_SEGUNDOS
    return _token_cache["valor"]


def _url_base() -> str:
    recurso, *_ = _config()
    return f"{recurso}/data"


def _requisitar(url: str, params: Optional[dict] = None) -> dict:
    """GET autenticado, com retentativa em falha passageira."""
    ultimo = ""
    for tentativa in range(_TENTATIVAS):
        try:
            resp = requests.get(
                url,
                params=params,
                headers={
                    "Authorization": f"Bearer {_token()}",
                    "Accept": "application/json",
                    # Sem isto o OData devolve o payload cheio de metadado de
                    # controle, que ninguém aqui usa e triplica o tamanho.
                    "OData-MaxVersion": "4.0",
                    "OData-Version": "4.0",
                },
                timeout=_TIMEOUT,
            )
        except requests.RequestException as e:
            ultimo = str(e)
            resp = None

        if resp is not None:
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 401:
                # Token pode ter sido revogado no meio do caminho: descarta o
                # cache e tenta uma vez com token novo. Se persistir, quase
                # sempre é o passo 2 do docstring — app não cadastrado no D365.
                _token_cache["valor"] = None
                ultimo = ("401 do D365. Confira se o Client ID está cadastrado em "
                          "Administração do sistema > Configurar > Aplicativos do "
                          "Microsoft Entra ID, vinculado a um usuário com função de leitura.")
            elif resp.status_code in (429, 500, 502, 503, 504):
                ultimo = f"{resp.status_code} do D365 (passageiro)"
            else:
                raise D365Indisponivel(f"D365 respondeu {resp.status_code}: {resp.text[:300]}")

        if tentativa < _TENTATIVAS - 1:
            time.sleep(_ESPERA_BASE * (2 ** tentativa))

    raise D365Indisponivel(f"D365 não respondeu depois de {_TENTATIVAS} tentativas. {ultimo}")


def listar(entidade: str, select: Optional[list] = None, filtro: Optional[str] = None,
           top: Optional[int] = None, ordenar: Optional[str] = None,
           cross_company: bool = False, max_paginas: int = _MAX_PAGINAS) -> list:
    """Linhas de uma entidade OData, seguindo a paginação até o fim.

    `select` é opcional mas quase sempre vale a pena: as entidades do F&O têm
    centenas de colunas, e pedir todas transforma uma consulta de 2s em 30s.

    `cross_company=True` traz todas as empresas legais; sem isso o D365 devolve
    só a empresa padrão do usuário de serviço — que é o motivo comum de "a
    consulta veio vazia" quando a MSB tem mais de uma.
    """
    params: dict = {}
    if select:
        params["$select"] = ",".join(select)
    if filtro:
        params["$filter"] = filtro
    if top:
        params["$top"] = int(top)
    if ordenar:
        params["$orderby"] = ordenar
    if cross_company:
        params["cross-company"] = "true"

    url = f"{_url_base()}/{entidade}"
    saida: list = []
    paginas = 0

    while url and paginas < max_paginas:
        dados = _requisitar(url, params if paginas == 0 else None)
        saida.extend(dados.get("value") or [])
        # O nextLink já vem com os parâmetros embutidos — repassá-los duplicaria.
        url = dados.get("@odata.nextLink")
        paginas += 1
        if top and len(saida) >= top:
            break

    return saida[:top] if top else saida


def entidades(busca: Optional[str] = None) -> list:
    """Nomes das entidades OData que ESTE ambiente expõe.

    Existe porque o catálogo do F&O varia com a versão e com os módulos
    habilitados — e chutar nome de entidade gera 404 que parece falta de
    permissão. Uma chamada aqui e a gente para de adivinhar.
    """
    dados = _metadata_xml()
    nomes = sorted({
        el.get("Name") for el in dados.iter()
        if el.tag.endswith("EntitySet") and el.get("Name")
    })
    if busca:
        alvo = busca.strip().lower()
        nomes = [n for n in nomes if alvo in n.lower()]
    return nomes


def campos(entidade: str) -> list:
    """Campos de uma entidade, do $metadata: nome e tipo.

    Ler o metadado é mais confiável do que inferir de uma amostra — campo nulo
    em todas as linhas da amostra simplesmente não apareceria.
    """
    raiz = _metadata_xml()
    alvo = (entidade or "").strip().lower()

    # O EntitySet aponta para um EntityType; o nome do tipo costuma ser o do set
    # no singular, mas não sempre — então resolve pelo vínculo declarado.
    tipo = None
    for el in raiz.iter():
        if el.tag.endswith("EntitySet") and (el.get("Name") or "").lower() == alvo:
            tipo = (el.get("EntityType") or "").split(".")[-1]
            break
    if not tipo:
        return []

    for el in raiz.iter():
        if el.tag.endswith("EntityType") and el.get("Name") == tipo:
            return [{"nome": p.get("Name"), "tipo": (p.get("Type") or "").replace("Edm.", "")}
                    for p in el if p.tag.endswith("Property") and p.get("Name")]
    return []


_metadata_cache: dict = {"em": 0.0, "raiz": None}
# O $metadata do F&O tem dezenas de MB e não muda em produção. Uma vez por hora
# por processo é de sobra, e evita pagar o download em cada consulta.
_METADATA_TTL = 3600


def _metadata_xml():
    agora = time.monotonic()
    if _metadata_cache["raiz"] is not None and (agora - _metadata_cache["em"]) < _METADATA_TTL:
        return _metadata_cache["raiz"]

    if not integracao_ativa():
        raise D365Indisponivel("Integração com o D365 não está configurada.")

    try:
        resp = requests.get(
            f"{_url_base()}/$metadata",
            headers={"Authorization": f"Bearer {_token()}", "Accept": "application/xml"},
            timeout=120,  # é um XML grande; o timeout padrão não dá conta
        )
    except requests.RequestException as e:
        raise D365Indisponivel(f"Não foi possível ler o catálogo do D365: {e}")
    if resp.status_code != 200:
        raise D365Indisponivel(f"Catálogo do D365 respondeu {resp.status_code}.")

    raiz = ElementTree.fromstring(resp.content)
    _metadata_cache["raiz"] = raiz
    _metadata_cache["em"] = agora
    return raiz


def diagnostico() -> dict:
    """O que está configurado e se a conexão fecha — sem expor segredo.

    Serve para responder "por que não funciona" sem ninguém precisar abrir log
    do Render: separa os três pontos que falham (falta config, Entra ID recusa,
    D365 recusa), porque a correção de cada um é em lugar diferente.
    """
    recurso, tenant, client_id, secret = _config()
    out = {
        "configurado": recurso is not None,
        # Só o suficiente para conferir que aponta para o ambiente certo.
        "ambiente": recurso,
        "empresa": empresa(),
        "tenant_informado": bool(tenant),
        "client_id_informado": bool(client_id),
        "secret_informado": bool(secret),
        "token_ok": False,
        "leitura_ok": False,
        "erro": None,
    }
    if not recurso:
        out["erro"] = ("Faltam variáveis de ambiente: D365_RESOURCE, D365_TENANT_ID, "
                       "D365_CLIENT_ID e D365_CLIENT_SECRET.")
        return out

    try:
        _token()
        out["token_ok"] = True
    except D365Indisponivel as e:
        out["erro"] = str(e)
        return out

    # Token válido e leitura falhando é o sintoma do app não cadastrado dentro do
    # D365 — daí valer a pena testar as duas coisas separadamente.
    try:
        entidades(busca="Customer")
        out["leitura_ok"] = True
    except D365Indisponivel as e:
        out["erro"] = str(e)
    return out
