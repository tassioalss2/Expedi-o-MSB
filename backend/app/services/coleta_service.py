# -*- coding: utf-8 -*-
"""A transportadora passou aqui hoje?

O combinado com a BRIX e a RR é coleta todo dia útil. Até agora não havia como
saber se elas cumpriram: o app registrava a coleta de cada carga, mas ninguém
lia isso como "o carro esteve na MSB".

A regra é a do Tássio (22/10/2026) e dispensa qualquer clique novo: quando o
operador registra a coleta de uma carga, a transportadora passou naquele dia —
ponto. Carga que entra no pallet DEPOIS disso não conta contra ela; só não
estava pronta quando o carro veio.

Falha é o inverso: dia útil em que havia carga esperando desde a véspera e
nenhuma coleta foi registrada. A janela de 7 dias existe porque carga parada há
mais tempo é outro problema — tem uma da BRIX no pallet desde 29/07, e sem o
corte ela acusaria a transportadora todo dia desde então.
"""
import collections
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from app.core.database import get_service_db
from app.services import calendario

# Transportadoras com coleta diária combinada. As demais vêm quando chamadas:
# cobrar passagem diária delas seria inventar um acordo que não existe.
COM_COLETA_DIARIA = ("BRIX", "RR CARGO")

# Carga esperando há mais de uma semana não é falha de coleta do dia.
JANELA_DIAS = 7

def _brt(ts) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return (datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                .astimezone(timezone.utc) - timedelta(hours=3))
    except ValueError:
        return None


def _hoje() -> date:
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _util(d: date) -> bool:
    return calendario.eh_util(d)


def _nome(pallet: dict) -> str:
    """O nome da transportadora do pallet, venha de onde vier.

    Pallet antigo guarda o nome na observação, e o fixo traz no código
    (PLT-BRIX). Sem os três caminhos, metade das coletas fica sem dono.
    """
    nome = ((pallet.get("transportadoras") or {}).get("nome")
            or pallet.get("observacao")
            or (pallet.get("codigo") or "").replace("PLT-", ""))
    return str(nome or "").strip().upper()


def _canonico(nome: str) -> Optional[str]:
    for alvo in COM_COLETA_DIARIA:
        if nome.startswith(alvo):
            return alvo
    return None


def _cargas() -> list:
    db = get_service_db()
    pallets, offset = {}, 0
    while True:
        bloco = (db.table("pallets").select("id, codigo, observacao, transportadoras(nome)")
                 .limit(1000).offset(offset).execute().data)
        pallets.update({p["id"]: p for p in bloco})
        if len(bloco) < 1000:
            break
        offset += 1000

    itens, offset = [], 0
    while True:
        bloco = (db.table("pallet_pedidos")
                 .select("pedido_id, pallet_id, adicionado_em, coletado_em, status")
                 .limit(1000).offset(offset).execute().data)
        itens += bloco
        if len(bloco) < 1000:
            break
        offset += 1000

    saida = []
    for i in itens:
        if i.get("status") == "CANCELADO":
            continue
        transportadora = _canonico(_nome(pallets.get(i["pallet_id"]) or {}))
        adicionado = _brt(i.get("adicionado_em"))
        if not transportadora or not adicionado:
            continue
        saida.append({
            "pedido_id": i.get("pedido_id"),
            "transportadora": transportadora,
            "adicionado": adicionado,
            "coletado": _brt(i.get("coletado_em")),
        })
    return saida


def painel(dias: int = 14) -> dict:
    """Passagem por dia e por transportadora, do mais recente para trás."""
    hoje = _hoje()
    cargas = _cargas()
    inicio = hoje - timedelta(days=dias)

    por_transportadora = {}
    for t in COM_COLETA_DIARIA:
        minhas = [c for c in cargas if c["transportadora"] == t]
        coletas_por_dia = collections.defaultdict(list)
        for c in minhas:
            if c["coletado"]:
                coletas_por_dia[c["coletado"].date()].append(c["coletado"])

        linhas, falhas = [], 0
        d = hoje
        while d > inicio:
            if not _util(d):
                d -= timedelta(days=1)
                continue
            coletas = sorted(coletas_por_dia.get(d, []))
            # O que já estava pronto quando o dia começou.
            esperando = [c for c in minhas
                         if c["adicionado"].date() < d
                         and (d - c["adicionado"].date()).days <= JANELA_DIAS
                         and (not c["coletado"] or c["coletado"].date() >= d)]
            # Hoje ainda não acabou: a ausência de coleta é "ainda não passou",
            # não falha. Acusar a transportadora às 9h da manhã seria injusto.
            falhou = bool(esperando) and not coletas and d != hoje
            falhas += 1 if falhou else 0
            linhas.append({
                "dia": d.isoformat(),
                "passou": bool(coletas),
                "primeira": coletas[0].strftime("%H:%M") if coletas else None,
                "ultima": coletas[-1].strftime("%H:%M") if coletas else None,
                "coletadas": len(coletas),
                # Entrou depois da última coleta: não é falha de ninguém.
                "entraram_depois": len([c for c in minhas
                                        if coletas and c["adicionado"].date() == d
                                        and c["adicionado"] > coletas[-1]]),
                "esperando": len(esperando),
                "falha": falhou,
                "hoje": d == hoje,
            })
            d -= timedelta(days=1)

        aguardando = [c for c in minhas if not c["coletado"]]
        por_transportadora[t] = {
            "dias": linhas,
            "falhas": falhas,
            "aguardando_agora": len(aguardando),
            "aguardando_desde": (min(c["adicionado"] for c in aguardando).date().isoformat()
                                 if aguardando else None),
            "passou_hoje": bool(coletas_por_dia.get(hoje)),
        }

    return {"hoje": hoje.isoformat(), "janela_dias": dias,
            "transportadoras": por_transportadora}


def dias_sem_falha() -> dict:
    """Há quanto tempo nenhuma transportadora deixou carga para trás."""
    hoje = _hoje()
    cargas = _cargas()
    ultima, detalhe = None, None

    for t in COM_COLETA_DIARIA:
        minhas = [c for c in cargas if c["transportadora"] == t]
        coletas = {c["coletado"].date() for c in minhas if c["coletado"]}
        d = hoje - timedelta(days=1)       # o dia corrente ainda não fechou
        limite = hoje - timedelta(days=180)
        while d > limite:
            if _util(d) and d not in coletas:
                esperando = [c for c in minhas
                             if c["adicionado"].date() < d
                             and (d - c["adicionado"].date()).days <= JANELA_DIAS
                             and (not c["coletado"] or c["coletado"].date() >= d)]
                if esperando and (ultima is None or d > ultima):
                    ultima, detalhe = d, {
                        "transportadora": t, "cargas": len(esperando),
                        "desde": min(c["adicionado"] for c in esperando).date().isoformat(),
                    }
                    break
            d -= timedelta(days=1)

    if ultima is None:
        return {"dias": None, "desde": None, "ultima": None, "nunca_aconteceu": True}
    return {
        "dias": calendario.dias_uteis_entre(ultima, hoje),
        "desde": ultima.isoformat(),
        "nunca_aconteceu": False,
        "ultima": {
            "tipo": "%s não passou" % detalhe["transportadora"],
            "descricao": ("%d carga(s) esperando desde %s e nenhuma coleta registrada no dia."
                          % (detalhe["cargas"],
                             "/".join(reversed(detalhe["desde"].split("-")[1:])))),
            "quando": ultima.isoformat(),
        },
    }
