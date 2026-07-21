"""Previsão de Faturamento.

Junta três fontes para estimar o fechamento do mês e do dia:
  1. Realizado — NFs já faturadas no mês (mesma definição do dashboard financeiro).
  2. Em processo — OVs no pipeline ainda não faturadas (valor estimado pelos itens).
  3. Saldo de contratos ganhos — empenhos com saldo a entregar.
  4. Em negociação — negócios lançados na entrada rápida, ponderados pela chance (%).

Garantido = realizado + em processo + saldo de contratos.
Previsão do mês = garantido + negociação ponderada.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.enums import StatusPedido
from app.models.schemas import PrevisaoNegocioCreate, PrevisaoNegocioUpdate
from app.services import pedido_service

# OVs que já contam como faturamento por natureza (mesma regra do dashboard).
_OPERACOES_FATURAMENTO = {"VENDA_NORMAL", "COMUNICADO_USO"}

# Pipeline: OVs ativas que ainda vão faturar (não inclui finalizadas/canceladas).
_STATUS_PIPELINE = [
    StatusPedido.AGUARD_CREDITO.value,
    StatusPedido.LIBERADO.value,
    StatusPedido.EM_INVENTARIO.value,
    StatusPedido.AGUARD_VERIFICACAO.value,
    StatusPedido.DIVERGENCIA.value,
    StatusPedido.AGUARD_TRATATIVA.value,
    StatusPedido.EM_PROCESSO_SISTEMICO.value,
    StatusPedido.EM_COTACAO_FRETE.value,
    StatusPedido.AGUARD_FATURAMENTO.value,
]
# Prestes a faturar (usado na previsão do dia).
_STATUS_QUASE_NF = [StatusPedido.EM_COTACAO_FRETE.value, StatusPedido.AGUARD_FATURAMENTO.value]

_STATUS_NEGOCIO = ["ABERTO", "GANHO", "PERDIDO"]


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conta_faturamento(tipo_operacao: Optional[str]) -> bool:
    return (tipo_operacao or "VENDA_NORMAL") in _OPERACOES_FATURAMENTO


def _valor_liquido_nf(p: dict) -> float:
    """Faturamento fiscal da NF: tira o CIF sem valor (não está na nota)."""
    nf = float(p.get("valor_nf") or 0)
    if p.get("tipo_frete") == "CIF_SEM_VALOR":
        nf -= float(p.get("valor_frete") or 0)
    return round(nf, 2)


# ── CRUD dos negócios (entrada rápida) ──────────────────────────────────────────

def _serializar(n: dict) -> dict:
    cli = n.pop("clientes", None) if isinstance(n.get("clientes"), dict) else None
    n["cliente"] = (cli or {}).get("nome") or n.get("cliente_nome")
    n["valor"] = float(n.get("valor") or 0)
    n["probabilidade"] = int(n.get("probabilidade") or 0)
    n["valor_ponderado"] = round(n["valor"] * n["probabilidade"] / 100, 2)
    return n


def listar_negocios(status: Optional[str] = None) -> list:
    db = get_service_db()
    q = db.table("previsao_negocios").select("*, clientes(nome)").eq("ativo", True)
    if status:
        q = q.eq("status", status)
    rows = q.order("previsao_fechamento").execute().data
    return [_serializar(r) for r in rows]


def criar_negocio(payload: PrevisaoNegocioCreate) -> dict:
    db = get_service_db()
    row = db.table("previsao_negocios").insert({
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "cliente_nome": (payload.cliente_nome or "").strip() or None,
        "descricao": payload.descricao,
        "valor": float(payload.valor or 0),
        "probabilidade": max(0, min(100, int(payload.probabilidade or 0))),
        "previsao_fechamento": payload.previsao_fechamento.isoformat() if payload.previsao_fechamento else None,
        "canal": payload.canal,
        "observacao": payload.observacao,
        "status": "ABERTO",
        "ativo": True,
    }).execute().data[0]
    return _serializar(db.table("previsao_negocios").select("*, clientes(nome)").eq("id", row["id"]).single().execute().data)


def atualizar_negocio(negocio_id: str, payload: PrevisaoNegocioUpdate) -> dict:
    db = get_service_db()
    atual = db.table("previsao_negocios").select("id").eq("id", negocio_id).execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Negócio não encontrado")

    update: dict = {"atualizado_em": _agora()}
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.cliente_nome is not None:
        update["cliente_nome"] = payload.cliente_nome.strip() or None
    if payload.descricao is not None:
        update["descricao"] = payload.descricao
    if payload.valor is not None:
        update["valor"] = float(payload.valor)
    if payload.probabilidade is not None:
        update["probabilidade"] = max(0, min(100, int(payload.probabilidade)))
    if payload.previsao_fechamento is not None:
        update["previsao_fechamento"] = payload.previsao_fechamento.isoformat()
    if payload.canal is not None:
        update["canal"] = payload.canal
    if payload.observacao is not None:
        update["observacao"] = payload.observacao
    if payload.status is not None:
        if payload.status not in _STATUS_NEGOCIO:
            raise HTTPException(status_code=422, detail="Status inválido")
        update["status"] = payload.status
        if payload.status == "GANHO":
            update["ganho_em"] = _agora()
        elif payload.status == "PERDIDO":
            update["perdido_em"] = _agora()

    db.table("previsao_negocios").update(update).eq("id", negocio_id).execute()
    return _serializar(db.table("previsao_negocios").select("*, clientes(nome)").eq("id", negocio_id).single().execute().data)


def remover_negocio(negocio_id: str) -> dict:
    db = get_service_db()
    db.table("previsao_negocios").update({"ativo": False, "atualizado_em": _agora()}).eq("id", negocio_id).execute()
    return {"ok": True}


# ── Cálculo da previsão ─────────────────────────────────────────────────────────

def _dias_uteis(inicio: date, fim: date) -> int:
    """Dias úteis (seg–sex) de `inicio` a `fim`, inclusive. Não considera feriados."""
    if fim < inicio:
        return 0
    d, n = inicio, 0
    while d <= fim:
        if d.weekday() < 5:
            n += 1
        d += timedelta(days=1)
    return n


def _realizado_mes(db, inicio: date, fim: date) -> float:
    """NFs faturadas no mês (BRT), líquidas, só operações de faturamento."""
    janela_ini = (inicio - timedelta(days=1)).isoformat()
    janela_fim = (fim + timedelta(days=1)).isoformat()
    movs = db.table("movimentacoes").select("pedido_id, criado_em")\
        .eq("status_novo", "FATURADO")\
        .gte("criado_em", f"{janela_ini}T00:00:00")\
        .lte("criado_em", f"{janela_fim}T23:59:59").execute().data
    ids_no_mes = set()
    for m in movs:
        ts_str, pid = m.get("criado_em"), m.get("pedido_id")
        if not ts_str or not pid:
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            dia = (ts.astimezone(timezone.utc) - timedelta(hours=3)).date()
        except Exception:
            continue
        if inicio <= dia <= fim:
            ids_no_mes.add(pid)
    if not ids_no_mes:
        return 0.0
    total = 0.0
    ids = list(ids_no_mes)
    for i in range(0, len(ids), 40):
        rows = db.table("pedidos").select("valor_nf, valor_frete, tipo_frete, tipo_operacao")\
            .in_("id", ids[i:i + 40]).execute().data
        for p in rows:
            if _conta_faturamento(p.get("tipo_operacao")):
                total += _valor_liquido_nf(p)
    return round(total, 2)


def _itens_por_pedido(db, ids: list) -> dict:
    """pedido_id -> valor estimado (Σ qtd_solicitada × valor_unitario)."""
    est: dict = {}
    for i in range(0, len(ids), 40):
        rows = db.table("itens_pedido").select("pedido_id, qtd_solicitada, valor_unitario")\
            .in_("pedido_id", ids[i:i + 40]).execute().data
        for it in rows:
            v = float(it.get("valor_unitario") or 0) * float(it.get("qtd_solicitada") or 0)
            est[it["pedido_id"]] = round(est.get(it["pedido_id"], 0.0) + v, 2)
    return est


def _pipeline(db) -> list:
    """OVs ativas ainda não faturadas, com valor estimado pelos itens."""
    rows = db.table("pedidos").select(
        "id, numero_pedido, status, canal, tipo_operacao, data_prevista_entrega, clientes(nome)"
    ).in_("status", _STATUS_PIPELINE).execute().data
    rows = [p for p in rows if _conta_faturamento(p.get("tipo_operacao"))]
    est = _itens_por_pedido(db, [p["id"] for p in rows]) if rows else {}
    out = []
    for p in rows:
        out.append({
            "id": p["id"],
            "numero_pedido": p.get("numero_pedido"),
            "status": p.get("status"),
            "cliente": (p.get("clientes") or {}).get("nome"),
            "canal": p.get("canal"),
            "data_prevista_entrega": p.get("data_prevista_entrega"),
            "valor_estimado": est.get(p["id"], 0.0),
            "quase_nf": p.get("status") in _STATUS_QUASE_NF,
        })
    out.sort(key=lambda x: x.get("data_prevista_entrega") or "9999")
    return out


def _saldo_contratos(db) -> float:
    """Σ (valor total do contrato − já faturado das OVs vinculadas), por empenho ativo."""
    emps = db.table("empenhos").select("id").eq("ativo", True).execute().data
    if not emps:
        return 0.0
    emp_ids = [e["id"] for e in emps]

    total_contrato: dict = {}
    for i in range(0, len(emp_ids), 40):
        its = db.table("empenho_itens").select("empenho_id, qtd_empenhada, valor_unitario")\
            .in_("empenho_id", emp_ids[i:i + 40]).execute().data
        for it in its:
            v = float(it.get("qtd_empenhada") or 0) * float(it.get("valor_unitario") or 0)
            total_contrato[it["empenho_id"]] = total_contrato.get(it["empenho_id"], 0.0) + v

    faturado_por_emp: dict = {}
    for i in range(0, len(emp_ids), 40):
        peds = db.table("pedidos").select("empenho_id, valor_nf, valor_frete, tipo_frete, status")\
            .in_("empenho_id", emp_ids[i:i + 40]).execute().data
        for p in peds:
            if p.get("status") in ("FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO") and p.get("valor_nf"):
                faturado_por_emp[p["empenho_id"]] = faturado_por_emp.get(p["empenho_id"], 0.0) + _valor_liquido_nf(p)

    saldo = 0.0
    for eid, total in total_contrato.items():
        saldo += max(0.0, total - faturado_por_emp.get(eid, 0.0))
    return round(saldo, 2)


def resumo() -> dict:
    db = get_service_db()
    hoje = date.today()
    inicio = date(hoje.year, hoje.month, 1)
    fim = date(hoje.year + (hoje.month // 12), (hoje.month % 12) + 1, 1) - timedelta(days=1)
    comp = f"{hoje.year:04d}-{hoje.month:02d}"

    realizado = _realizado_mes(db, inicio, fim)
    pipeline = _pipeline(db)
    em_processo_total = round(sum(p["valor_estimado"] for p in pipeline), 2)
    saldo_contratos = _saldo_contratos(db)
    garantido = round(realizado + em_processo_total + saldo_contratos, 2)

    try:
        negocios = listar_negocios("ABERTO")
    except Exception:
        # Tabela ainda não migrada — degrada sem quebrar o resto da previsão.
        negocios = []
    hoje_iso, fim_iso = hoje.isoformat(), fim.isoformat()

    def _no_mes(n: dict) -> bool:
        pf = n.get("previsao_fechamento")
        return (not pf) or (pf <= fim_iso)

    neg_mes = [n for n in negocios if _no_mes(n)]
    negociacao_bruto = round(sum(n["valor"] for n in neg_mes), 2)
    negociacao_ponderado = round(sum(n["valor_ponderado"] for n in neg_mes), 2)
    previsao_mes = round(garantido + negociacao_ponderado, 2)

    # Previsão do dia
    quase_nf = round(sum(p["valor_estimado"] for p in pipeline if p["quase_nf"]), 2)
    neg_hoje = round(sum(n["valor_ponderado"] for n in negocios if n.get("previsao_fechamento") == hoje_iso), 2)
    previsto_hoje = round(quase_nf + neg_hoje, 2)

    meta_info = pedido_service.obter_meta(comp)
    meta = meta_info.get("valor")
    dias_restantes = _dias_uteis(hoje, fim)
    falta = round(max(0.0, meta - realizado), 2) if meta else None
    ritmo_necessario = round(falta / dias_restantes, 2) if (falta is not None and dias_restantes > 0) else None

    return {
        "competencia": comp,
        "hoje": hoje_iso,
        "mes": {
            "realizado": realizado,
            "em_processo": em_processo_total,
            "saldo_contratos": saldo_contratos,
            "garantido": garantido,
            "negociacao_bruto": negociacao_bruto,
            "negociacao_ponderado": negociacao_ponderado,
            "previsao": previsao_mes,
            "meta": meta,
            "atingimento_previsto_pct": round(previsao_mes / meta * 100, 1) if meta else None,
        },
        "dia": {
            "previsto_hoje": previsto_hoje,
            "quase_nf": quase_nf,
            "negociacao_hoje": neg_hoje,
            "dias_uteis_restantes": dias_restantes,
            "falta_meta": falta,
            "ritmo_necessario": ritmo_necessario,
        },
        "pipeline": pipeline,
        "negocios": negocios,
    }
