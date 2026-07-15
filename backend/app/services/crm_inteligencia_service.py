"""CRM · Inteligência de mercado.

Gera oportunidades acionáveis a partir dos DADOS PRÓPRIOS de venda da empresa
(pedidos, itens, clientes) — não de fontes externas. Entrega:
- Win-back: clientes que compravam e pararam (inativos).
- Ranking de clientes por faturamento.
- Produtos mais vendidos por canal.
- Cross-sell: produtos do canal que o cliente ainda não comprou.
"""
from datetime import datetime, timezone
from typing import Optional

from app.core.database import get_service_db

_STATUS_CANCELADO = "CANCELADO"
_LIMITE_LINHAS = 2000


def _valor(p: dict) -> float:
    v = p.get("valor_nf")
    if v is None:
        v = p.get("valor_produtos")
    return float(v or 0)


def _parse(ts: Optional[str]):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def _carregar():
    db = get_service_db()
    pedidos = db.table("pedidos").select(
        "id, cliente_id, canal, status, tipo_operacao, valor_nf, valor_produtos, criado_em"
    ).neq("status", _STATUS_CANCELADO).order("criado_em", desc=True).limit(_LIMITE_LINHAS).execute().data
    clientes = db.table("clientes").select("id, nome, ativo").execute().data
    cli_nome = {c["id"]: c.get("nome") for c in clientes}
    return db, pedidos, cli_nome


def dashboard_inteligencia(dias_inatividade: int = 90) -> dict:
    db, pedidos, cli_nome = _carregar()
    agora = datetime.now(timezone.utc)

    # Agrega por cliente
    por_cliente: dict = {}
    for p in pedidos:
        cid = p.get("cliente_id")
        if not cid:
            continue
        d = _parse(p.get("criado_em"))
        val = _valor(p)
        c = por_cliente.setdefault(cid, {"total": 0.0, "count": 0, "ultima": None, "ultima_ts": None, "canais": {}})
        c["total"] += val
        c["count"] += 1
        if d and (c["ultima_ts"] is None or d > c["ultima_ts"]):
            c["ultima_ts"] = d
            c["ultima"] = p.get("criado_em")
        canal = p.get("canal")
        if canal:
            c["canais"][canal] = c["canais"].get(canal, 0) + 1

    # Win-back: inativos há mais de N dias, que já geraram valor
    win_back = []
    for cid, c in por_cliente.items():
        if c["total"] <= 0 or not c["ultima_ts"]:
            continue
        dias = (agora - c["ultima_ts"]).days
        if dias >= dias_inatividade:
            win_back.append({
                "cliente_id": cid, "cliente": cli_nome.get(cid, "—"),
                "dias_inativo": dias, "valor_historico": round(c["total"], 2),
                "pedidos": c["count"], "ultima_compra": (c["ultima"] or "")[:10],
                "canal": max(c["canais"], key=c["canais"].get) if c["canais"] else None,
            })
    win_back.sort(key=lambda x: (-x["valor_historico"], -x["dias_inativo"]))

    # Top clientes (últimos 365 dias)
    top = []
    for cid, c in por_cliente.items():
        top.append({
            "cliente_id": cid, "cliente": cli_nome.get(cid, "—"),
            "valor": round(c["total"], 2), "pedidos": c["count"],
            "canal": max(c["canais"], key=c["canais"].get) if c["canais"] else None,
        })
    top.sort(key=lambda x: -x["valor"])

    # Produtos por canal (usa itens_pedido)
    ped_ids = [p["id"] for p in pedidos]
    ped_canal = {p["id"]: p.get("canal") for p in pedidos}
    ped_cliente = {p["id"]: p.get("cliente_id") for p in pedidos}
    itens = []
    for i in range(0, len(ped_ids), 80):
        lote = ped_ids[i:i + 80]
        if not lote:
            continue
        itens += db.table("itens_pedido").select("pedido_id, produto_id, qtd_solicitada").in_("pedido_id", lote).execute().data

    prod_ids = list({it["produto_id"] for it in itens if it.get("produto_id")})
    prod_info = {}
    for i in range(0, len(prod_ids), 80):
        lote = prod_ids[i:i + 80]
        if not lote:
            continue
        for pr in db.table("produtos").select("id, codigo, descricao").in_("id", lote).execute().data:
            prod_info[pr["id"]] = pr

    # canal -> produto -> qtd ; cliente -> set(produto)
    canal_prod: dict = {}
    cliente_prod: dict = {}
    for it in itens:
        pid = it.get("produto_id")
        if not pid:
            continue
        ped = it.get("pedido_id")
        canal = ped_canal.get(ped)
        cid = ped_cliente.get(ped)
        qtd = float(it.get("qtd_solicitada") or 0)
        if canal:
            canal_prod.setdefault(canal, {}).setdefault(pid, 0.0)
            canal_prod[canal][pid] += qtd
        if cid:
            cliente_prod.setdefault(cid, set()).add(pid)

    produtos_por_canal = []
    canal_top_ordenado: dict = {}
    for canal, prods in canal_prod.items():
        ordenados = sorted(prods.items(), key=lambda x: -x[1])
        canal_top_ordenado[canal] = [pid for pid, _ in ordenados]
        produtos_por_canal.append({
            "canal": canal,
            "produtos": [{
                "produto_id": pid,
                "codigo": (prod_info.get(pid) or {}).get("codigo"),
                "descricao": (prod_info.get(pid) or {}).get("descricao"),
                "qtd": round(q),
            } for pid, q in ordenados[:8]],
        })

    # Cross-sell: para clientes ativos, top produtos do canal que ele ainda não comprou
    cross_sell = []
    limite_ativo = agora
    for cid, c in por_cliente.items():
        if not c["ultima_ts"] or (limite_ativo - c["ultima_ts"]).days > 180:
            continue
        canal = max(c["canais"], key=c["canais"].get) if c["canais"] else None
        if not canal or canal not in canal_top_ordenado:
            continue
        comprados = cliente_prod.get(cid, set())
        sugeridos = [pid for pid in canal_top_ordenado[canal] if pid not in comprados][:3]
        if not sugeridos:
            continue
        cross_sell.append({
            "cliente_id": cid, "cliente": cli_nome.get(cid, "—"), "canal": canal,
            "sugestoes": [{
                "produto_id": pid,
                "codigo": (prod_info.get(pid) or {}).get("codigo"),
                "descricao": (prod_info.get(pid) or {}).get("descricao"),
            } for pid in sugeridos],
        })
    cross_sell.sort(key=lambda x: -por_cliente[x["cliente_id"]]["total"])

    return {
        "base_pedidos": len(pedidos),
        "amostra_limitada": len(pedidos) >= _LIMITE_LINHAS,
        "dias_inatividade": dias_inatividade,
        "win_back": win_back[:20],
        "top_clientes": top[:15],
        "produtos_por_canal": produtos_por_canal,
        "cross_sell": cross_sell[:20],
        "resumo": {
            "clientes_ativos": sum(1 for c in por_cliente.values() if c["ultima_ts"] and (agora - c["ultima_ts"]).days <= 180),
            "clientes_inativos": len(win_back),
            "valor_em_risco": round(sum(w["valor_historico"] for w in win_back), 2),
        },
    }
