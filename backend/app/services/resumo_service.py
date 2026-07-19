"""Resumo diário no Teams — o que precisa de atenção hoje.

Enviado automaticamente às 08h (BRT, seg-sex) pelo agendador iniciado no startup,
ou manualmente pelo botão no painel. Usa o mesmo webhook das notificações de OV.
Marca o envio do dia em app_estado para não duplicar (fallback em memória se a
tabela ainda não existir).
"""
import threading
import time
from datetime import datetime, timezone, timedelta

from app.core.database import get_service_db

_BRT = timezone(timedelta(hours=-3))
_ETAPAS_FINAIS = {"NF_ENVIADA", "CONCLUIDO"}
_marcador_memoria: set = set()
_agendador_iniciado = False


def _hoje_brt() -> str:
    return datetime.now(_BRT).date().isoformat()


def _fmt(d: str) -> str:
    try:
        return datetime.fromisoformat(d[:10]).strftime("%d/%m")
    except Exception:
        return d or ""


def montar_resumo() -> str:
    db = get_service_db()
    hoje = _hoje_brt()
    ontem = (datetime.now(_BRT).date() - timedelta(days=1)).isoformat()
    linhas: list[str] = []

    # 1) Demandas de licitação paradas há 2+ dias
    try:
        dem = db.table("licitacao_demandas").select("etapa, criado_em, clientes(nome)")\
            .eq("ativo", True).execute().data
        limite = datetime.now(timezone.utc) - timedelta(days=2)
        paradas = []
        for d in dem:
            etapa = d.get("etapa")
            if etapa in _ETAPAS_FINAIS:
                continue
            try:
                criado = datetime.fromisoformat((d.get("criado_em") or "").replace("Z", "+00:00"))
            except Exception:
                continue
            if criado <= limite:
                dias = (datetime.now(timezone.utc) - criado).days
                paradas.append((dias, (d.get("clientes") or {}).get("nome") or "?"))
        if paradas:
            paradas.sort(reverse=True)
            tops = " · ".join(f"{n} ({dd}d)" for dd, n in paradas[:5])
            linhas.append(f"⏳ **{len(paradas)} demanda(s) de licitação parada(s) há 2+ dias**: {tops}")
    except Exception:
        pass

    # 2) OVs atrasadas (entrega prevista vencida e ainda não expedidas)
    try:
        peds = db.table("pedidos").select("numero_pedido, status, data_prevista_entrega, clientes(nome)")\
            .neq("status", "CANCELADO").lte("data_prevista_entrega", ontem).execute().data
        atrasadas = [p for p in peds if p.get("status") != "EXPEDIDO"]
        if atrasadas:
            atrasadas.sort(key=lambda p: p.get("data_prevista_entrega") or "")
            tops = " · ".join(
                f"{p['numero_pedido']} ({_fmt(p.get('data_prevista_entrega'))})" for p in atrasadas[:5])
            linhas.append(f"🔴 **{len(atrasadas)} OV(s) atrasada(s)**: {tops}")
    except Exception:
        pass

    # 3) OVs aguardando faturamento
    try:
        fat = db.table("pedidos").select("numero_pedido").eq("status", "AGUARD_FATURAMENTO").execute().data
        if fat:
            linhas.append(f"📦 **{len(fat)} OV(s) aguardando faturamento**")
    except Exception:
        pass

    # 4) Licitações com NF pendente de envio ao cliente (OV gerada / frete cotado)
    try:
        dem = db.table("licitacao_demandas").select("etapa, clientes(nome)")\
            .eq("ativo", True).execute().data
        pend = [(d.get("clientes") or {}).get("nome") or "?"
                for d in dem if d.get("etapa") in ("OV_GERADA", "COTACAO_FRETE")]
        if pend:
            linhas.append(f"📄 **{len(pend)} NF(s) pendente(s) de envio ao cliente**: {' · '.join(pend[:5])}")
    except Exception:
        pass

    # 5) Contratos vencendo em 15 dias (ou vencidos) com saldo
    try:
        from app.services import licitacao_service
        limite = (datetime.now(_BRT).date() + timedelta(days=15)).isoformat()
        risco = [e for e in licitacao_service.listar_empenhos()
                 if e.get("saldo_un", 0) > 0 and e.get("vigencia") and e["vigencia"] <= limite]
        if risco:
            tops = " · ".join(f"{e['numero']} (até {_fmt(e['vigencia'])})" for e in risco[:5])
            linhas.append(f"⚠️ **{len(risco)} contrato(s) vencendo com saldo**: {tops}")
    except Exception:
        pass

    data_fmt = datetime.now(_BRT).strftime("%d/%m/%Y")
    if not linhas:
        return f"☀️ **Resumo ACE-MSB — {data_fmt}**\n\n✅ Tudo em dia — nada pendente de atenção."
    corpo = "\n\n".join(f"- {l}" for l in linhas)
    return f"☀️ **Resumo ACE-MSB — {data_fmt}**\n\n{corpo}\n\n_Detalhes no app: painel de licitações e expedição._"


def _ja_enviado_hoje(db, hoje: str) -> bool:
    try:
        r = db.table("app_estado").select("valor").eq("chave", "resumo_diario_ultimo").execute().data
        return bool(r) and r[0].get("valor") == hoje
    except Exception:
        return hoje in _marcador_memoria


def _marcar_enviado(db, hoje: str) -> None:
    _marcador_memoria.add(hoje)
    try:
        r = db.table("app_estado").select("chave").eq("chave", "resumo_diario_ultimo").execute().data
        if r:
            db.table("app_estado").update({"valor": hoje}).eq("chave", "resumo_diario_ultimo").execute()
        else:
            db.table("app_estado").insert({"chave": "resumo_diario_ultimo", "valor": hoje}).execute()
    except Exception:
        pass


def enviar_resumo(forcar: bool = False) -> dict:
    """Monta e envia o resumo ao Teams. Sem `forcar`, não reenvia no mesmo dia."""
    from app.services.pedido_service import _enviar_teams

    db = get_service_db()
    hoje = _hoje_brt()
    if not forcar and _ja_enviado_hoje(db, hoje):
        return {"ok": True, "enviado": False, "motivo": "já enviado hoje"}
    texto = montar_resumo()
    _enviar_teams(texto)
    _marcar_enviado(db, hoje)
    return {"ok": True, "enviado": True, "texto": texto}


def _loop_agendador() -> None:
    while True:
        try:
            agora = datetime.now(_BRT)
            # Seg-sex, a partir das 08h (se o serviço acordar depois, envia na hora)
            if agora.weekday() < 5 and agora.hour >= 8:
                enviar_resumo(forcar=False)
        except Exception:
            pass
        time.sleep(300)


def iniciar_agendador() -> None:
    global _agendador_iniciado
    if _agendador_iniciado:
        return
    _agendador_iniciado = True
    threading.Thread(target=_loop_agendador, daemon=True).start()
