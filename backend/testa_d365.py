# -*- coding: utf-8 -*-
"""Cliente do D365 sem D365: substitui `requests` por um dublê.

Nao existe ambiente de teste do D365 aqui, e o de producao e o sistema fiscal —
nao e lugar de descobrir bug. O que se testa e o que e nosso: token em cache,
paginacao, retentativa, o 401 descartando o token, e o segredo nao vazando.
"""
import sys
import time
sys.path.insert(0, '.')
from dotenv import load_dotenv
load_dotenv()

from app.services import d365_service as d
from app.core.config import settings

ok = True


def checa(rotulo, cond, extra=""):
    global ok
    ok = ok and cond
    print(f"   {'OK  ' if cond else '*** FALHOU ***'} {rotulo} {extra}")


# ── configuracao de mentira, so para o modulo se considerar ativo ────────────
settings.d365_resource = "https://fake.operations.dynamics.com"
settings.d365_tenant_id = "tenant-fake"
settings.d365_client_id = "client-fake"
settings.d365_client_secret = "SEGREDO-QUE-NAO-PODE-VAZAR"
settings.d365_empresa = "msb"

CHAMADAS = {"token": 0, "get": 0}


class Resp:
    def __init__(self, status, payload=None, texto="", conteudo=b""):
        self.status_code = status
        self._payload = payload or {}
        self.text = texto
        self.content = conteudo

    def json(self):
        return self._payload


class FakeRequests:
    """Sequencia de respostas programada por teste."""
    def __init__(self):
        self.respostas_get = []
        self.token_status = 200
        self.expires_in = 3600
        self.ultimo_get = None

    def post(self, url, data=None, timeout=None):
        CHAMADAS["token"] += 1
        assert "oauth2/v2.0/token" in url, url
        # O escopo tem que ser recurso + /.default; item a item nao funciona no
        # fluxo de aplicacao.
        assert data["scope"] == "https://fake.operations.dynamics.com/.default", data["scope"]
        if self.token_status != 200:
            return Resp(self.token_status, {"error_description": "secret expirado"})
        return Resp(200, {"access_token": f"tk{CHAMADAS['token']}", "expires_in": self.expires_in})

    def get(self, url, params=None, headers=None, timeout=None):
        CHAMADAS["get"] += 1
        self.ultimo_get = {"url": url, "params": params, "headers": headers}
        return self.respostas_get.pop(0) if self.respostas_get else Resp(200, {"value": []})


class RequestException(Exception):
    pass


fake = FakeRequests()
fake.RequestException = RequestException
d.requests = fake
d.requests.RequestException = RequestException

print("1) token: pega uma vez e reusa do cache")
d._token_cache.update({"valor": None, "expira_em": 0.0})
t1 = d._token()
t2 = d._token()
checa("mesmo token nas duas chamadas", t1 == t2, t1)
checa("bateu no Entra ID uma vez so", CHAMADAS["token"] == 1, str(CHAMADAS["token"]))

print("\n2) token quase expirando e renovado antes de estourar")
d._token_cache.update({"valor": None, "expira_em": 0.0})
fake.expires_in = 200          # menor que a margem de 300s
d._token()
checa("expira_em ja no passado (vai renovar)", d._token_cache["expira_em"] <= time.monotonic())
fake.expires_in = 3600

print("\n3) Entra ID recusando: erro claro e SEM vazar o segredo")
d._token_cache.update({"valor": None, "expira_em": 0.0})
fake.token_status = 401
try:
    d._token()
    checa("levanta D365Indisponivel", False)
except d.D365Indisponivel as e:
    msg = str(e)
    checa("levanta D365Indisponivel", True)
    checa("explica o motivo", "secret expirado" in msg, msg[:60])
    checa("NAO contem o segredo", "SEGREDO-QUE-NAO-PODE-VAZAR" not in msg)
fake.token_status = 200

print("\n4) listar: monta os parametros do OData")
d._token_cache.update({"valor": None, "expira_em": 0.0})
fake.respostas_get = [Resp(200, {"value": [{"a": 1}]})]
d.listar("SalesOrderHeadersV2", select=["SalesOrderNumber", "OrderTotalAmount"],
         filtro="SalesOrderStatus eq 'Backorder'", top=10, ordenar="SalesOrderNumber",
         cross_company=True)
p = fake.ultimo_get["params"]
checa("$select", p["$select"] == "SalesOrderNumber,OrderTotalAmount", p["$select"])
checa("$filter", p["$filter"] == "SalesOrderStatus eq 'Backorder'")
checa("$top", p["$top"] == 10)
checa("$orderby", p["$orderby"] == "SalesOrderNumber")
checa("cross-company", p["cross-company"] == "true")
checa("url monta com /data/", fake.ultimo_get["url"].endswith("/data/SalesOrderHeadersV2"),
      fake.ultimo_get["url"])
checa("manda o Bearer", fake.ultimo_get["headers"]["Authorization"].startswith("Bearer "))

print("\n5) paginacao: segue o nextLink e junta tudo")
fake.respostas_get = [
    Resp(200, {"value": [{"i": 1}, {"i": 2}], "@odata.nextLink": "https://fake/p2"}),
    Resp(200, {"value": [{"i": 3}], "@odata.nextLink": "https://fake/p3"}),
    Resp(200, {"value": [{"i": 4}]}),
]
r = d.listar("Qualquer")
checa("juntou as 3 paginas", [x["i"] for x in r] == [1, 2, 3, 4], str(r))

print("\n6) nextLink nao leva os parametros de novo (viriam duplicados)")
fake.respostas_get = [
    Resp(200, {"value": [{"i": 1}], "@odata.nextLink": "https://fake/p2"}),
    Resp(200, {"value": [{"i": 2}]}),
]
d.listar("Qualquer", select=["X"])
checa("2a pagina sem params", fake.ultimo_get["params"] is None, str(fake.ultimo_get["params"]))

print("\n7) teto de paginas: filtro esquecido nao varre a base inteira")
fake.respostas_get = [Resp(200, {"value": [{"i": n}], "@odata.nextLink": "https://fake/x"})
                      for n in range(50)]
r = d.listar("Qualquer", max_paginas=3)
checa("parou no teto", len(r) == 3, f"{len(r)} linhas")

print("\n8) top corta mesmo quando a pagina traz mais")
fake.respostas_get = [Resp(200, {"value": [{"i": 1}, {"i": 2}, {"i": 3}]})]
checa("respeita o top", len(d.listar("Q", top=2)) == 2)

print("\n9) 429 e passageiro: tenta de novo e devolve o dado")
d._ESPERA_BASE_ORIGINAL = d._ESPERA_BASE
d._ESPERA_BASE = 0            # o teste nao precisa esperar de verdade
fake.respostas_get = [Resp(429), Resp(200, {"value": [{"ok": True}]})]
r = d.listar("Q")
checa("recuperou depois do 429", r == [{"ok": True}], str(r))

print("\n10) 401 descarta o token e tenta com um novo")
d._token_cache.update({"valor": "tk-velho", "expira_em": time.monotonic() + 9999})
fake.respostas_get = [Resp(401), Resp(200, {"value": [{"ok": True}]})]
antes = CHAMADAS["token"]
r = d.listar("Q")
checa("recuperou depois do 401", r == [{"ok": True}])
checa("buscou token novo", CHAMADAS["token"] > antes, f"{antes} -> {CHAMADAS['token']}")

print("\n11) 401 insistente explica o cadastro dentro do D365")
fake.respostas_get = [Resp(401), Resp(401), Resp(401)]
try:
    d.listar("Q")
    checa("levanta apos esgotar", False)
except d.D365Indisponivel as e:
    checa("levanta apos esgotar", True)
    checa("cita o cadastro no D365", "Microsoft Entra ID" in str(e), str(e)[-80:])

print("\n12) erro definitivo (404) nao fica tentando")
fake.respostas_get = [Resp(404, texto="Resource not found")]
antes = CHAMADAS["get"]
try:
    d.listar("EntidadeQueNaoExiste")
    checa("propaga o 404", False)
except d.D365Indisponivel as e:
    checa("propaga o 404", "404" in str(e), str(e)[:50])
    checa("nao repetiu a chamada", CHAMADAS["get"] - antes == 1, f"{CHAMADAS['get'] - antes} chamada(s)")
d._ESPERA_BASE = d._ESPERA_BASE_ORIGINAL

print("\n13) integracao desligada: nao explode, apenas informa")
settings.d365_resource = None
checa("integracao_ativa False", d.integracao_ativa() is False)
diag = d.diagnostico()
checa("diagnostico aponta a falta", diag["configurado"] is False and "D365_RESOURCE" in diag["erro"])
checa("diagnostico nao devolve segredo",
      "SEGREDO-QUE-NAO-PODE-VAZAR" not in str(diag), str(diag)[:60])

print("\n14) o modulo nao tem como escrever no D365")
proibidos = [n for n in dir(d) if n in ("post", "patch", "put", "delete", "criar",
                                        "atualizar", "gravar", "escrever")]
checa("nenhuma funcao de escrita exportada", proibidos == [], str(proibidos))

print("\n" + ("TUDO OK" if ok else "*** TEM FALHA ACIMA ***"))
