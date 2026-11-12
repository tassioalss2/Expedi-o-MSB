# -*- coding: utf-8 -*-
"""Leitura das cargas do Portal MSB.

O Kanban está saindo do ACE para o Portal MSB, e com ele as cargas. A
conferência da fatura da transportadora só funciona porque tem a nossa carga
do lado do CT-e — sem as cargas aqui, ela morre junto com o Kanban.

O Portal expõe `GET /api/kanban-ov`, que lê o D365 ao vivo (entidades
BioSalesOrderHeadersV1, WHSLoadTableBiEntities, SalesInvoiceHeadersV2). Este
módulo lê essa API e grava um ESPELHO em `cargas_portal`.

Três decisões que valem explicação:

1. **Espelho, não fonte.** Nada aqui escreve em `pedidos`. Se o Portal
   discordar do app — tipo de frete, destino —, a divergência é RELATADA, não
   resolvida. Quem registrou a OV teve um motivo, e um importador não é lugar
   para desempatar isso no escuro.

2. **A carga não depende da OV existir no app.** Em 12/11/2026, 16 das 41 OVs
   do Portal não existiam no ACE — são as novas, nascidas direto no D365. Esse
   número vai para 100% quando o Kanban sair. Por isso a OV é texto, não FK:
   amarrar em `pedidos` faria o espelho recusar justamente a carga que ele
   precisa guardar.

3. **A API está aberta.** Em 12/11/2026 ela respondia sem token nenhum — o
   login do Entra protege a página, não a rota /api. Isso é um problema de
   segurança do Portal, não uma facilidade para nós: quando for corrigido, a
   leitura passa a precisar de credencial. `PORTAL_MSB_TOKEN` existe desde já
   para esse dia, e a falha vai vir como 401, não como mistério.
"""
import os
from datetime import datetime, timezone
from typing import Optional

import requests

from app.core.database import get_service_db

URL_PADRAO = "https://brave-island-00b6b7a0f.1.azurestaticapps.net/api/kanban-ov"

# A função do Azure hiberna: a primeira chamada depois de um tempo parado
# devolve 503 e a seguinte leva ~20 s. Por isso o timeout largo e a repetição.
TIMEOUT = 120
TENTATIVAS = 3

# O tipo de frete como o D365 escreve, traduzido para o vocabulário do app.
# Medido em 12/11/2026 contra as 25 OVs que existiam nos dois lados:
#   ChargeFreight     -> FOB            8 de 8   (o Portal marca fob=true)
#   PrepaidWithoutNFe -> CIF_SEM_VALOR 11 de 12
#   Prepayd           -> CIF_COM_VALOR  1 de 1
# "Blank" e vazio ficam de fora de propósito: frete indefinido no D365 não
# vira tipo de frete por conveniência nossa.
TRADUCAO_FRETE = {
    "chargefreight": "FOB",
    "prepaidwithoutnfe": "CIF_SEM_VALOR",
    "prepayd": "CIF_COM_VALOR",
    "prepaid": "CIF_COM_VALOR",
}


def _url() -> str:
    return (os.getenv("PORTAL_MSB_URL") or URL_PADRAO).strip()


def buscar() -> dict:
    """O payload do Portal, cru.

    Repete no 503 porque a função do Azure hiberna — o primeiro acesso do dia
    quase sempre falha assim, e tratar isso como erro faria a tela acusar queda
    onde há só sono.
    """
    cab = {"Accept": "application/json"}
    token = (os.getenv("PORTAL_MSB_TOKEN") or "").strip()
    if token:
        cab["Authorization"] = "Bearer %s" % token

    erro = None
    for tentativa in range(TENTATIVAS):
        try:
            r = requests.get(_url(), headers=cab, timeout=TIMEOUT)
            if r.status_code == 503 and tentativa < TENTATIVAS - 1:
                erro = "503 (função hibernando)"
                continue
            if r.status_code in (401, 403):
                raise ValueError(
                    "O Portal recusou a leitura (%d). A API deixou de ser aberta: "
                    "é preciso uma credencial em PORTAL_MSB_TOKEN." % r.status_code)
            r.raise_for_status()
            return r.json()
        except ValueError:
            raise
        except Exception as exc:                       # rede, timeout, JSON
            erro = str(exc)[:160]
    raise ValueError("Não consegui ler o Portal: %s" % erro)


def _texto(v) -> Optional[str]:
    t = ("" if v is None else str(v)).strip()
    return t or None


def _num(v) -> Optional[float]:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _quando(v) -> Optional[str]:
    """ISO do Portal, devolvido como o banco gosta. Vazio vira nulo."""
    t = _texto(v)
    if not t:
        return None
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return None


def _peso(ov: dict) -> Optional[float]:
    """Peso real da carga, em kg.

    Vem da entidade de carga do D365 e só existe depois que a carga é criada —
    em 12/11 eram 23 das 41 OVs. Nulo aqui quer dizer "ainda não se sabe", e é
    por isso que ele não vira zero: zero faria o frete sair pelo peso mínimo e
    parecer uma resposta.
    """
    carga = (ov.get("campos") or {}).get("WHSLoadTableBiEntities") or {}
    return _num(carga.get("LoadWeight")) or _num(carga.get("LoadNetWeight"))


def _tipo_frete(ov: dict) -> tuple:
    """(como o D365 escreve, a tradução do app ou None)."""
    f = ov.get("frete") or {}
    valores = [v for v in (f.get("valores") or []) if _texto(v)]
    bruto = _texto(valores[0]) if valores else None
    if f.get("fob"):
        return bruto or "ChargeFreight", "FOB"
    return bruto, TRADUCAO_FRETE.get((bruto or "").strip().lower())


def _linhas(payload: dict) -> list:
    """Uma linha por CARGA, com o contexto da OV junto.

    OV sem carga nenhuma não vira linha: o que esta tabela guarda é carga. A OV
    sem carga ainda não tem o que conferir contra CT-e nenhum, e inventar uma
    linha vazia para ela só encheria o espelho de nada.
    """
    saida = []
    for ov in payload.get("ovs") or []:
        nota = ov.get("nota") or {}
        for carga in ov.get("cargas") or []:
            cid = _texto(carga.get("id"))
            if not cid:
                continue
            bruto, traduzido = _tipo_frete(ov)
            saida.append({
                "carga_id": cid,
                "numero_ov": _texto(ov.get("numero")),
                "cliente_nome": _texto(ov.get("cliente")),
                "cliente_codigo": _texto(ov.get("conta")),
                "cidade": _texto(ov.get("cidade")),
                "uf": _texto(ov.get("uf")),
                "numero_nf": _texto(nota.get("numero")),
                "valor_nf": _num(ov.get("valor")),
                "itens": ov.get("itens"),
                "peso_kg": _peso(ov),
                "status": _texto(carga.get("status")),
                "fase": _texto(carga.get("fase")),
                "etapa_ov": _texto(ov.get("etapa")),
                "deposito": _texto(carga.get("deposito") or ov.get("deposito")),
                "transportadora": _texto(carga.get("transportadora")),
                "tipo_frete_portal": bruto,
                "tipo_frete": traduzido,
                "envio_em": _quando(carga.get("envio")),
                "expedido_em": _quando(carga.get("expedido")),
                "envio_confirmado_em": _quando(carga.get("envioConfirmado")),
                "entrega_prevista": _quando(ov.get("entrega")),
                "ov_criada_em": _quando(ov.get("criadaEm")),
                "payload": {"ov": ov.get("numero"), "carga": carga},
            })
    return saida


def _contexto_do_app(db, linhas: list) -> dict:
    """O que o ACE já sabe sobre essas OVs, para medir a divergência."""
    ovs = sorted({l["numero_ov"] for l in linhas if l.get("numero_ov")})
    achados = {}
    for i in range(0, len(ovs), 40):
        fatia = ovs[i:i + 40]
        try:
            r = db.table("pedidos").select(
                "id, numero_pedido, numero_nf, local_entrega, tipo_frete, status"
            ).in_("numero_pedido", fatia).execute().data
        except Exception as exc:
            print("contexto do app indisponivel: %s" % str(exc)[:140])
            r = []
        for p in r:
            achados[str(p.get("numero_pedido") or "").strip().upper()] = p
    return achados


def _clientes_por_codigo(db, linhas: list) -> dict:
    """clientes.codigo é o código do D365 (C001367) — casamento exato."""
    cods = sorted({l["cliente_codigo"] for l in linhas if l.get("cliente_codigo")})
    mapa = {}
    for i in range(0, len(cods), 40):
        try:
            r = db.table("clientes").select("id, codigo").in_(
                "codigo", cods[i:i + 40]).execute().data
        except Exception as exc:
            print("clientes indisponiveis: %s" % str(exc)[:140])
            r = []
        for c in r:
            mapa[str(c.get("codigo") or "").strip().upper()] = c["id"]
    return mapa


def _divergencias(linhas: list, no_app: dict) -> dict:
    """Onde o Portal e o app discordam — relatado, nunca corrigido aqui."""
    so_no_portal, frete, destino = [], [], []
    vistas = set()
    for l in linhas:
        ov = (l.get("numero_ov") or "").upper()
        if not ov or ov in vistas:
            continue
        vistas.add(ov)
        p = no_app.get(ov)
        if not p:
            so_no_portal.append({"ov": l["numero_ov"], "cliente": l["cliente_nome"],
                                 "valor": l["valor_nf"], "etapa": l["etapa_ov"]})
            continue
        if l.get("tipo_frete") and p.get("tipo_frete") and l["tipo_frete"] != p["tipo_frete"]:
            frete.append({"ov": l["numero_ov"], "portal": l["tipo_frete"],
                          "portal_bruto": l["tipo_frete_portal"], "app": p["tipo_frete"]})
        loc = (p.get("local_entrega") or "").strip()
        if loc and l.get("cidade"):
            alvo = "%s/%s" % (l["cidade"], l.get("uf") or "")
            if loc.upper().replace(" ", "") != alvo.upper().replace(" ", ""):
                destino.append({"ov": l["numero_ov"], "portal": alvo, "app": loc})
    return {"so_no_portal": so_no_portal, "frete": frete, "destino": destino}


def previa() -> dict:
    """Lê o Portal e mostra o que entraria, sem gravar nada."""
    return _rodar(gravar=False, usuario=None)


def importar(usuario=None) -> dict:
    """Lê o Portal e grava o espelho."""
    return _rodar(gravar=True, usuario=usuario)


def _rodar(gravar: bool, usuario) -> dict:
    payload = buscar()
    linhas = _linhas(payload)
    db = get_service_db()

    no_app = _contexto_do_app(db, linhas)
    divs = _divergencias(linhas, no_app)

    if gravar:
        clientes = _clientes_por_codigo(db, linhas)
        agora = datetime.now(timezone.utc).isoformat()
        for l in linhas:
            l["cliente_id"] = clientes.get((l.get("cliente_codigo") or "").upper())
            l["importado_em"] = agora
            l["atualizado_em"] = agora
            if usuario is not None and getattr(usuario, "id", None):
                l["importado_por"] = str(usuario.id)
        # on_conflict no LoadId: carga não muda de identidade, muda de status.
        for i in range(0, len(linhas), 200):
            db.table("cargas_portal").upsert(
                linhas[i:i + 200], on_conflict="carga_id").execute()

    com_peso = sum(1 for l in linhas if l.get("peso_kg"))
    com_nf = sum(1 for l in linhas if l.get("numero_nf"))
    return {
        "gravou": gravar,
        "lido_em": payload.get("geradoEm"),
        "ovs_no_portal": len(payload.get("ovs") or []),
        "cargas": len(linhas),
        "com_peso": com_peso,
        "sem_peso": len(linhas) - com_peso,
        "com_nf": com_nf,
        "ovs_so_no_portal": len(divs["so_no_portal"]),
        "divergencias": divs,
        # Os avisos que o próprio Portal publica sobre a leitura dele do D365.
        # Entram aqui porque explicam buraco no espelho que não é nosso: carga
        # que o D365 não devolve não vira linha, e isso precisa ter nome.
        "avisos_do_portal": payload.get("avisos") or [],
        "amostra": linhas[:5],
    }
