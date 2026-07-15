"""Gestão de Licitações — empenhos consignados e consumo via comunicado de uso."""
from datetime import date
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import ComunicadoUsoCreate, ConsumoEmpenhoCreate, EmpenhoCreate, UsuarioOut


def _status(vigencia: Optional[str], saldo_un: float, empenhado_un: float) -> str:
    if empenhado_un > 0 and saldo_un <= 0.001:
        return "CONCLUIDO"
    vencido = bool(vigencia and vigencia < date.today().isoformat())
    if vencido:
        return "VENCIDO"
    if saldo_un < empenhado_un:
        return "PARCIAL"
    return "ABERTO"


def _consumo_por_empenho(db, empenho_ids: list[str]) -> dict:
    """{empenho_id: {produto_id: qtd_consumida}} a partir dos comunicados vinculados."""
    consumo: dict = {}
    if not empenho_ids:
        return consumo
    for i in range(0, len(empenho_ids), 80):
        lote = empenho_ids[i:i + 80]
        peds = db.table("pedidos").select("id, empenho_id, itens_pedido(produto_id, qtd_solicitada)")\
            .in_("empenho_id", lote).neq("status", "CANCELADO").execute().data
        for p in peds:
            emp = p.get("empenho_id")
            if not emp:
                continue
            alvo = consumo.setdefault(emp, {})
            for it in (p.get("itens_pedido") or []):
                pid = it.get("produto_id")
                if pid:
                    alvo[pid] = alvo.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)
    return consumo


def _resumo_empenho(itens: list, consumo_prod: dict) -> dict:
    empenhado_un = empenhado_vl = faturado_un = faturado_vl = 0.0
    for it in itens:
        q = float(it.get("qtd_empenhada") or 0)
        vu = float(it.get("valor_unitario") or 0)
        cons = min(float(consumo_prod.get(it.get("produto_id"), 0.0)), q)
        empenhado_un += q
        empenhado_vl += q * vu
        faturado_un += cons
        faturado_vl += cons * vu
    return {
        "empenhado_un": round(empenhado_un),
        "empenhado_valor": round(empenhado_vl, 2),
        "faturado_un": round(faturado_un),
        "faturado_valor": round(faturado_vl, 2),
        "saldo_un": round(empenhado_un - faturado_un),
        "saldo_valor": round(empenhado_vl - faturado_vl, 2),
        "percentual": round(faturado_un / empenhado_un * 100) if empenhado_un else 0,
    }


def criar_empenho(payload: EmpenhoCreate) -> dict:
    db = get_service_db()
    existe = db.table("empenhos").select("id").eq("numero", payload.numero).eq("ativo", True).execute()
    if existe.data:
        raise HTTPException(status_code=409, detail=f"Já existe um empenho com o número '{payload.numero}'.")

    emp = db.table("empenhos").insert({
        "numero": payload.numero,
        "cliente_id": str(payload.cliente_id),
        "data_empenho": payload.data_empenho.isoformat() if payload.data_empenho else None,
        "vigencia": payload.vigencia.isoformat() if payload.vigencia else None,
        "observacao": payload.observacao,
        "ativo": True,
    }).execute().data[0]

    if payload.itens:
        prod_ids = [str(i.produto_id) for i in payload.itens]
        prods = {p["id"]: p for p in db.table("produtos").select("id, codigo, descricao").in_("id", prod_ids).execute().data}
        linhas = []
        for it in payload.itens:
            pr = prods.get(str(it.produto_id), {})
            linhas.append({
                "empenho_id": emp["id"],
                "produto_id": str(it.produto_id),
                "codigo": pr.get("codigo"),
                "descricao": pr.get("descricao"),
                "qtd_empenhada": it.qtd_empenhada,
                "valor_unitario": it.valor_unitario,
            })
        db.table("empenho_itens").insert(linhas).execute()

    return obter_empenho(emp["id"])


def listar_empenhos() -> list:
    db = get_service_db()
    empenhos = db.table("empenhos").select("*, clientes(nome)").eq("ativo", True).order("criado_em", desc=True).execute().data
    if not empenhos:
        return []
    ids = [e["id"] for e in empenhos]
    itens = db.table("empenho_itens").select("*").in_("empenho_id", ids).execute().data
    itens_por_emp: dict = {}
    for it in itens:
        itens_por_emp.setdefault(it["empenho_id"], []).append(it)
    consumo = _consumo_por_empenho(db, ids)

    result = []
    for e in empenhos:
        its = itens_por_emp.get(e["id"], [])
        resumo = _resumo_empenho(its, consumo.get(e["id"], {}))
        result.append({
            "id": e["id"],
            "numero": e["numero"],
            "cliente": (e.get("clientes") or {}).get("nome", "—"),
            "cliente_id": e.get("cliente_id"),
            "data_empenho": e.get("data_empenho"),
            "vigencia": e.get("vigencia"),
            "observacao": e.get("observacao"),
            "qtd_itens": len(its),
            "status": _status(e.get("vigencia"), resumo["saldo_un"], resumo["empenhado_un"]),
            **resumo,
        })
    return result


def obter_empenho(empenho_id: str) -> dict:
    db = get_service_db()
    e = db.table("empenhos").select("*, clientes(nome)").eq("id", empenho_id).single().execute().data
    if not e:
        raise HTTPException(status_code=404, detail="Empenho não encontrado")
    itens = db.table("empenho_itens").select("*").eq("empenho_id", empenho_id).execute().data
    consumo = _consumo_por_empenho(db, [empenho_id]).get(empenho_id, {})

    itens_out = []
    for it in itens:
        q = float(it.get("qtd_empenhada") or 0)
        vu = float(it.get("valor_unitario") or 0)
        cons = min(float(consumo.get(it.get("produto_id"), 0.0)), q)
        itens_out.append({
            "produto_id": it.get("produto_id"),
            "codigo": it.get("codigo"),
            "descricao": it.get("descricao"),
            "qtd_empenhada": round(q),
            "valor_unitario": vu,
            "qtd_faturada": round(cons),
            "qtd_saldo": round(q - cons),
            "valor_saldo": round((q - cons) * vu, 2),
        })

    # Comunicados (consumos) vinculados
    comunicados = db.table("pedidos").select("id, numero_pedido, numero_nf, valor_nf, data_prevista_entrega, criado_em")\
        .eq("empenho_id", empenho_id).neq("status", "CANCELADO").order("criado_em", desc=True).execute().data
    consumos = [{
        "id": c["id"],
        "numero_pedido": c.get("numero_pedido"),
        "numero_nf": c.get("numero_nf"),
        "valor_nf": c.get("valor_nf"),
        "data": (c.get("data_prevista_entrega") or (c.get("criado_em") or "")[:10]),
    } for c in comunicados]

    resumo = _resumo_empenho(itens, consumo)
    return {
        "id": e["id"],
        "numero": e["numero"],
        "cliente": (e.get("clientes") or {}).get("nome", "—"),
        "cliente_id": e.get("cliente_id"),
        "data_empenho": e.get("data_empenho"),
        "vigencia": e.get("vigencia"),
        "observacao": e.get("observacao"),
        "status": _status(e.get("vigencia"), resumo["saldo_un"], resumo["empenhado_un"]),
        **resumo,
        "itens": itens_out,
        "consumos": consumos,
    }


def registrar_consumo(empenho_id: str, payload: ConsumoEmpenhoCreate, usuario: UsuarioOut) -> dict:
    from app.services import pedido_service
    db = get_service_db()
    emp = db.table("empenhos").select("id, cliente_id").eq("id", empenho_id).single().execute().data
    if not emp:
        raise HTTPException(status_code=404, detail="Empenho não encontrado")
    if not payload.itens:
        raise HTTPException(status_code=422, detail="Informe ao menos um item consumido")

    # Valida saldo por item antes de faturar
    detalhe = obter_empenho(empenho_id)
    saldo = {i["produto_id"]: i["qtd_saldo"] for i in detalhe["itens"]}
    for it in payload.itens:
        pid = str(it.produto_id)
        if pid not in saldo:
            raise HTTPException(status_code=422, detail="Item não pertence a este empenho")
        if it.qtd_solicitada > saldo[pid] + 0.001:
            raise HTTPException(status_code=422, detail=f"Quantidade acima do saldo do item (saldo {saldo[pid]})")

    comunicado = ComunicadoUsoCreate(
        numero_pedido=payload.numero_pedido,
        cliente_id=emp["cliente_id"],
        numero_nf=payload.numero_nf,
        valor_nf=payload.valor_nf,
        canal=payload.canal,
        data_faturamento=payload.data_faturamento,
        observacoes=payload.observacoes,
        itens=payload.itens,
        empenho_id=empenho_id,
    )
    pedido_service.criar_comunicado_uso(comunicado, usuario)
    return obter_empenho(empenho_id)


def excluir_empenho(empenho_id: str) -> dict:
    db = get_service_db()
    vinculos = db.table("pedidos").select("id").eq("empenho_id", empenho_id).neq("status", "CANCELADO").execute().data
    if vinculos:
        raise HTTPException(status_code=400, detail="Empenho já tem comunicados de uso lançados — não pode ser excluído")
    db.table("empenhos").update({"ativo": False}).eq("id", empenho_id).execute()
    return {"ok": True}
