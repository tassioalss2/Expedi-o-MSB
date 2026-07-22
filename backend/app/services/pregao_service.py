"""Pregão mestre.

Fluxo: ganha-se o PREGÃO (com o total de itens/quantidades). Depois vão
chegando as NOTAS DE EMPENHO (NE = empenhos), cada uma consumindo parte do
total do pregão. Cada NE gera suas OVs pelo fluxo de empenhos já existente.

Saldo do pregão (por item) = qtd_total − Σ qtd_empenhada das NEs vinculadas.
"""
from datetime import date, datetime, timezone

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import EmpenhoCreate, EmpenhoItemCreate, NeCreate, PregaoCreate
from app.services import licitacao_service


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _itens_pregao_json(itens, db) -> list:
    """Resolve código/descrição dos produtos e monta o jsonb dos itens do pregão."""
    if not itens:
        return []
    prod_ids = [str(i.produto_id) for i in itens]
    prods = {p["id"]: p for p in db.table("produtos").select("id, codigo, descricao").in_("id", prod_ids).execute().data}
    linhas = []
    for it in itens:
        pr = prods.get(str(it.produto_id), {})
        linhas.append({
            "produto_id": str(it.produto_id),
            "codigo": pr.get("codigo"),
            "descricao": pr.get("descricao"),
            "qtd_total": float(it.qtd_total),
            "valor_unitario": float(it.valor_unitario or 0),
        })
    return linhas


def _empenhado_por_produto(db, empenho_ids: list) -> dict:
    """produto_id -> Σ qtd_empenhada nas NEs informadas."""
    emp: dict = {}
    if not empenho_ids:
        return emp
    for i in range(0, len(empenho_ids), 40):
        its = db.table("empenho_itens").select("produto_id, qtd_empenhada")\
            .in_("empenho_id", empenho_ids[i:i + 40]).execute().data
        for it in its:
            pid = it.get("produto_id")
            if pid:
                emp[pid] = emp.get(pid, 0.0) + float(it.get("qtd_empenhada") or 0)
    return emp


def _resumo_ne(db, emp: dict) -> dict:
    """Resumo de uma NE (empenho) — reaproveita os cálculos de licitacao_service."""
    its = db.table("empenho_itens").select("*").eq("empenho_id", emp["id"]).execute().data
    consumo = licitacao_service._consumo_por_empenho(db, [emp["id"]]).get(emp["id"], {})
    resumo = licitacao_service._resumo_empenho(its, consumo)
    return {
        "id": emp["id"],
        "numero": emp.get("numero"),
        "tipo": emp.get("tipo") or "VENDA_DIRETA",
        "data_empenho": emp.get("data_empenho"),
        "vigencia": emp.get("vigencia"),
        "status": licitacao_service._status(emp.get("vigencia"), resumo["saldo_un"], resumo["empenhado_un"]),
        **resumo,
    }


def _montar_pregao(db, p: dict, nes: list) -> dict:
    """Consolida um pregão com suas NEs (total, empenhado, saldo, entregue)."""
    itens = p.get("itens") or []
    preco = {i["produto_id"]: float(i.get("valor_unitario") or 0) for i in itens}
    total_un = sum(float(i.get("qtd_total") or 0) for i in itens)
    total_valor = sum(float(i.get("qtd_total") or 0) * preco.get(i["produto_id"], 0.0) for i in itens)

    ne_ids = [n["id"] for n in nes]
    empenhado_prod = _empenhado_por_produto(db, ne_ids)
    empenhado_un = sum(empenhado_prod.values())
    empenhado_valor = sum(q * preco.get(pid, 0.0) for pid, q in empenhado_prod.items())

    nes_out = [_resumo_ne(db, n) for n in nes]
    entregue_valor = sum(n["faturado_valor"] for n in nes_out)

    itens_out = []
    for i in itens:
        pid = i["produto_id"]
        qt = float(i.get("qtd_total") or 0)
        emp = min(empenhado_prod.get(pid, 0.0), qt)
        itens_out.append({
            "produto_id": pid,
            "codigo": i.get("codigo"),
            "descricao": i.get("descricao"),
            "qtd_total": round(qt),
            "valor_unitario": preco.get(pid, 0.0),
            "qtd_empenhada": round(empenhado_prod.get(pid, 0.0)),
            "qtd_saldo": round(max(0.0, qt - emp)),
        })

    saldo_un = max(0.0, total_un - empenhado_un)
    saldo_valor = round(total_valor - empenhado_valor, 2)
    return {
        "id": p["id"],
        "numero": p["numero"],
        "cliente": (p.get("clientes") or {}).get("nome", "—"),
        "cliente_id": p.get("cliente_id"),
        "canal": p.get("canal"),
        "tipo": p.get("tipo") or "VENDA_DIRETA",
        "data": p.get("data"),
        "vigencia": p.get("vigencia"),
        "observacao": p.get("observacao"),
        "total_un": round(total_un),
        "total_valor": round(total_valor, 2),
        "empenhado_un": round(empenhado_un),
        "empenhado_valor": round(empenhado_valor, 2),
        "saldo_un": round(saldo_un),
        "saldo_valor": round(max(0.0, saldo_valor), 2),
        "entregue_valor": round(entregue_valor, 2),
        "percentual_empenhado": round(empenhado_valor / total_valor * 100) if total_valor else 0,
        "qtd_nes": len(nes),
        "itens": itens_out,
        "nes": nes_out,
    }


def criar_pregao(payload: PregaoCreate) -> dict:
    db = get_service_db()
    row = db.table("pregoes").insert({
        "numero": payload.numero,
        "cliente_id": str(payload.cliente_id),
        "canal": payload.canal,
        "tipo": payload.tipo or "VENDA_DIRETA",
        "data": payload.data.isoformat() if payload.data else None,
        "vigencia": payload.vigencia.isoformat() if payload.vigencia else None,
        "observacao": payload.observacao,
        "itens": _itens_pregao_json(payload.itens, db),
        "ativo": True,
    }).execute().data[0]
    return obter_pregao(row["id"])


def listar_pregoes() -> list:
    db = get_service_db()
    try:
        pregoes = db.table("pregoes").select("*, clientes(nome)").eq("ativo", True).order("criado_em", desc=True).execute().data
    except Exception:
        # Tabela ainda não migrada (v15) — degrada sem quebrar a aba Contratos.
        return []
    if not pregoes:
        return []
    ids = [p["id"] for p in pregoes]
    nes_por_pregao: dict = {}
    for i in range(0, len(ids), 40):
        emps = db.table("empenhos").select("*").in_("pregao_id", ids[i:i + 40]).eq("ativo", True).execute().data
        for e in emps:
            nes_por_pregao.setdefault(e["pregao_id"], []).append(e)
    return [_montar_pregao(db, p, nes_por_pregao.get(p["id"], [])) for p in pregoes]


def obter_pregao(pregao_id: str) -> dict:
    db = get_service_db()
    p = db.table("pregoes").select("*, clientes(nome)").eq("id", pregao_id).single().execute().data
    if not p:
        raise HTTPException(status_code=404, detail="Pregão não encontrado")
    nes = db.table("empenhos").select("*").eq("pregao_id", pregao_id).eq("ativo", True).order("criado_em").execute().data
    return _montar_pregao(db, p, nes)


def criar_ne(pregao_id: str, payload: NeCreate, usuario) -> dict:
    """Cria uma NE (empenho) dentro do pregão, consumindo o saldo por item e
    herdando o preço unitário do pregão."""
    db = get_service_db()
    detalhe = obter_pregao(pregao_id)
    if not payload.itens:
        raise HTTPException(status_code=422, detail="Informe ao menos um item da nota de empenho.")

    saldo = {i["produto_id"]: i["qtd_saldo"] for i in detalhe["itens"]}
    preco = {i["produto_id"]: float(i.get("valor_unitario") or 0) for i in detalhe["itens"]}
    itens_emp = []
    for it in payload.itens:
        pid = str(it.produto_id)
        if pid not in saldo:
            raise HTTPException(status_code=422, detail="Item não pertence a este pregão.")
        if it.qtd > saldo[pid] + 0.001:
            raise HTTPException(status_code=422, detail=f"Quantidade acima do saldo do pregão para o item (saldo {saldo[pid]}).")
        itens_emp.append(EmpenhoItemCreate(produto_id=it.produto_id, qtd_empenhada=float(it.qtd), valor_unitario=preco.get(pid, 0.0)))

    vig = payload.vigencia
    if vig is None and detalhe.get("vigencia"):
        vig = date.fromisoformat(detalhe["vigencia"])
    licitacao_service.criar_empenho(EmpenhoCreate(
        numero=payload.numero,
        numero_pregao=detalhe["numero"],
        cliente_id=detalhe["cliente_id"],
        tipo=detalhe["tipo"],
        canal=detalhe["canal"],
        data_empenho=payload.data_empenho,
        vigencia=vig,
        observacao=payload.observacao,
        itens=itens_emp,
        pregao_id=pregao_id,
    ))
    return obter_pregao(pregao_id)


def excluir_pregao(pregao_id: str) -> dict:
    db = get_service_db()
    nes = db.table("empenhos").select("id").eq("pregao_id", pregao_id).eq("ativo", True).execute().data
    if nes:
        raise HTTPException(status_code=400, detail="Remova as notas de empenho antes de excluir o pregão.")
    db.table("pregoes").update({"ativo": False, "atualizado_em": _agora()}).eq("id", pregao_id).execute()
    return {"ok": True}
