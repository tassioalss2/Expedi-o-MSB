"""Painel de demandas de licitação — triagem visual (Kanban) das operações que
chegam por e-mail (venda direta, consignação, comunicado de uso).

Cada demanda é um card que anda pelas etapas NOVO → ANALISE → PROCESSANDO →
CONCLUIDO. Ao concluir, o app gera automaticamente o artefato correspondente:
- VENDA_DIRETA  → cria a OV no fluxo logístico
- CONSIGNACAO   → cria o empenho
- COMUNICADO_USO→ registra o comunicado de uso (baixando saldo de um empenho, se houver)
"""
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import (
    ComunicadoUsoCreate,
    ConsumoEmpenhoCreate,
    DemandaConcluir,
    DemandaCreate,
    DemandaUpdate,
    EmpenhoCreate,
    EmpenhoItemCreate,
    ItemPedidoCreate,
    PedidoCreate,
    UsuarioOut,
)

ETAPAS = ["RECEBIDO", "PROCESSANDO", "CONCLUIDO"]
# Etapas antigas → novas (compatibilidade com registros já criados)
_ETAPA_LEGADA = {"NOVO": "RECEBIDO", "ANALISE": "RECEBIDO"}
TIPOS = ["VENDA_DIRETA", "CONSIGNACAO", "COMUNICADO_USO"]
_PRIORIDADE_PESO = {"CRITICA": 0, "ALTA": 1, "NORMAL": 2}


def _agora() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _hoje_brt() -> str:
    """Data de hoje no fuso de Brasília (YYYY-MM-DD)."""
    from datetime import datetime, timezone, timedelta
    return datetime.now(timezone(timedelta(hours=-3))).date().isoformat()


def _data_brt(iso: Optional[str]) -> str:
    """Converte um timestamp ISO (UTC) para a data no fuso de Brasília."""
    if not iso:
        return ""
    from datetime import datetime, timezone, timedelta
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone(timedelta(hours=-3))).date().isoformat()
    except Exception:
        return iso[:10]


def _itens_json(itens) -> list:
    """Serializa DemandaItem[] para gravar no jsonb."""
    out = []
    for it in itens or []:
        out.append({
            "produto_id": str(it.produto_id) if it.produto_id else None,
            "codigo": it.codigo,
            "descricao": it.descricao,
            "qtd": float(it.qtd or 0),
            "valor": float(it.valor or 0),
        })
    return out


def _serializar(d: dict) -> dict:
    return {
        "id": d["id"],
        "tipo_operacao": d.get("tipo_operacao"),
        "etapa": _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa")),
        "ref_externa": d.get("ref_externa"),
        "numero": d.get("numero"),
        "cliente_id": d.get("cliente_id"),
        "cliente": (d.get("clientes") or {}).get("nome") if d.get("clientes") else None,
        "canal": d.get("canal"),
        "prazo": d.get("prazo"),
        "prioridade": d.get("prioridade") or "NORMAL",
        "observacao": d.get("observacao"),
        "responsavel_id": d.get("responsavel_id"),
        "itens": d.get("itens") or [],
        "gerado_tipo": d.get("gerado_tipo"),
        "gerado_id": d.get("gerado_id"),
        "gerado_ref": d.get("gerado_ref"),
        "ovs": d.get("ovs") or [],
        "ovs_detalhe": None,
        "ov_status": None,
        "ov_itens": None,
        "criado_em": d.get("criado_em"),
        "concluido_em": d.get("concluido_em"),
    }


def _ov_ids_de(d: dict) -> list:
    """Ids de todas as OVs vinculadas à demanda (lista `ovs`, com fallback para o
    gerado_id legado quando ainda não foi migrado)."""
    ids = [o.get("id") for o in (d.get("ovs") or []) if o.get("id")]
    if not ids and d.get("gerado_tipo") in ("PEDIDO", "COMUNICADO") and d.get("gerado_id"):
        ids = [d.get("gerado_id")]
    return ids


def _anexar_ov_status(db, demandas: list) -> None:
    """Para demandas vinculadas a OVs, busca o status atual e os itens reais de
    cada OV para o card espelhar o fluxo logístico ao vivo e comparar as
    quantidades da triagem (previsto) com o total faturado nas OVs (realizado)."""
    todos: list = []
    for d in demandas:
        todos.extend(_ov_ids_de(d))
    if not todos:
        return
    uniq = list(dict.fromkeys(todos))
    status_map: dict = {}
    itens_map: dict = {}
    for i in range(0, len(uniq), 80):
        lote = uniq[i:i + 80]
        for p in db.table("pedidos").select("id, numero_pedido, status").in_("id", lote).execute().data:
            status_map[p["id"]] = {"numero": p.get("numero_pedido"), "status": p.get("status")}
        itrows = db.table("itens_pedido")\
            .select("pedido_id, produto_id, qtd_solicitada, produtos(codigo, descricao)")\
            .in_("pedido_id", lote).execute().data
        for it in itrows:
            prod = it.get("produtos") or {}
            itens_map.setdefault(it["pedido_id"], []).append({
                "produto_id": it.get("produto_id"),
                "codigo": prod.get("codigo"),
                "descricao": prod.get("descricao"),
                "qtd": float(it.get("qtd_solicitada") or 0),
            })
    for d in demandas:
        ids = _ov_ids_de(d)
        if not ids:
            continue
        d["ovs_detalhe"] = [{
            "id": i,
            "numero": (status_map.get(i) or {}).get("numero"),
            "status": (status_map.get(i) or {}).get("status"),
        } for i in ids]
        prim = status_map.get(ids[0])
        if prim:
            d["ov_status"] = prim.get("status")
        # Soma dos itens de todas as OVs (por produto) = total realizado.
        agg: dict = {}
        for i in ids:
            for it in itens_map.get(i, []):
                k = it.get("produto_id") or it.get("codigo")
                cur = agg.setdefault(k, {"produto_id": it.get("produto_id"), "codigo": it.get("codigo"),
                                         "descricao": it.get("descricao"), "qtd": 0.0})
                cur["qtd"] += it.get("qtd") or 0.0
        if agg:
            d["ov_itens"] = list(agg.values())


def listar_demandas() -> list:
    """Painel do dia: pendentes (qualquer dia) + concluídas HOJE. As concluídas de
    dias anteriores saem do painel automaticamente (ficam no histórico)."""
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("criado_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    hoje = _hoje_brt()

    def visivel(d: dict) -> bool:
        if d["etapa"] != "CONCLUIDO":
            return True
        ce = d.get("concluido_em")
        return (not ce) or _data_brt(ce) == hoje

    demandas = [d for d in demandas if visivel(d)]
    _anexar_ov_status(db, demandas)
    demandas.sort(key=lambda d: (_PRIORIDADE_PESO.get(d["prioridade"], 3), d.get("prazo") or "9999"))
    return demandas


def historico_datas() -> list:
    """Dias que têm demandas concluídas, com a contagem — para o seletor do histórico."""
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("etapa, concluido_em")\
        .eq("ativo", True).execute().data
    cont: dict = {}
    for r in rows:
        etapa = _ETAPA_LEGADA.get(r.get("etapa"), r.get("etapa"))
        ce = r.get("concluido_em")
        if etapa == "CONCLUIDO" and ce:
            dia = _data_brt(ce)
            cont[dia] = cont.get(dia, 0) + 1
    return sorted([{"data": k, "total": v} for k, v in cont.items()], key=lambda x: x["data"], reverse=True)


def historico_demandas(data: str) -> list:
    """Demandas concluídas em uma data específica (fuso de Brasília)."""
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("concluido_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    alvo = (data or "").strip()[:10]
    out = [d for d in demandas
           if d["etapa"] == "CONCLUIDO" and d.get("concluido_em") and _data_brt(d["concluido_em"]) == alvo]
    _anexar_ov_status(db, out)
    return out


def criar_demanda(payload: DemandaCreate) -> dict:
    if payload.tipo_operacao not in TIPOS:
        raise HTTPException(status_code=422, detail="Tipo de operação inválido")
    db = get_service_db()
    row = db.table("licitacao_demandas").insert({
        "tipo_operacao": payload.tipo_operacao,
        "etapa": "RECEBIDO",
        "numero": (payload.numero or "").strip() or None,
        "cliente_id": str(payload.cliente_id),
        "canal": payload.canal,
        "prazo": payload.prazo.isoformat() if payload.prazo else None,
        "prioridade": payload.prioridade or "NORMAL",
        "observacao": payload.observacao,
        "itens": _itens_json(payload.itens),
        "ativo": True,
    }).execute().data[0]
    return obter_demanda(row["id"])


def obter_demanda(demanda_id: str) -> dict:
    db = get_service_db()
    r = db.table("licitacao_demandas").select("*, clientes(nome)").eq("id", demanda_id).single().execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    d = _serializar(r)
    _anexar_ov_status(db, [d])
    return d


def vincular_ov(demanda_id: str, numero_pedido: str) -> dict:
    """Vincula a demanda a uma OV existente no fluxo logístico. O card passa a
    espelhar o status real da OV (aguardando faturamento, faturado, expedido…)."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    num = (numero_pedido or "").strip().upper()
    if not num:
        raise HTTPException(status_code=422, detail="Informe o número da OV")
    peds = db.table("pedidos").select("id, numero_pedido, status, criado_em")\
        .eq("numero_pedido", num).neq("status", "CANCELADO").order("criado_em", desc=True).execute().data
    if not peds:
        raise HTTPException(status_code=404, detail=f"Nenhuma OV ativa encontrada com o número '{num}'.")
    ped = peds[0]
    ovs = list(d.get("ovs") or [])
    if not any(o.get("id") == ped["id"] for o in ovs):
        ovs.append({"id": ped["id"], "numero": ped["numero_pedido"]})
    update = {"ovs": ovs, "atualizado_em": _agora()}
    if not d.get("gerado_id"):
        update.update({
            "gerado_tipo": "PEDIDO",
            "gerado_id": ped["id"],
            "gerado_ref": ped["numero_pedido"],
            "ref_externa": ped["numero_pedido"],
        })
    if _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa")) == "RECEBIDO":
        update["etapa"] = "PROCESSANDO"
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def _saldo_demanda(db, d: dict) -> dict:
    """Saldo por produto = total da triagem − soma do que já saiu nas OVs vinculadas."""
    total: dict = {}
    for it in (d.get("itens") or []):
        pid = it.get("produto_id")
        if pid:
            total[pid] = total.get(pid, 0.0) + float(it.get("qtd") or 0)
    ids = _ov_ids_de(d)
    entregue: dict = {}
    for i in range(0, len(ids), 80):
        lote = ids[i:i + 80]
        for it in db.table("itens_pedido").select("produto_id, qtd_solicitada").in_("pedido_id", lote).execute().data:
            pid = it.get("produto_id")
            if pid:
                entregue[pid] = entregue.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)
    return {pid: max(0.0, q - entregue.get(pid, 0.0)) for pid, q in total.items()}


def gerar_ov_saldo(demanda_id: str, payload, usuario: UsuarioOut) -> dict:
    """Gera uma OV no fluxo logístico com o saldo (ou parte dele) de uma venda
    direta parcial. A OV é vinculada à demanda; o saldo restante continua rastreado."""
    from app.services import pedido_service

    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    if d.get("tipo_operacao") != "VENDA_DIRETA":
        raise HTTPException(status_code=400, detail="Gerar OV do saldo vale só para venda direta.")
    if not payload.itens:
        raise HTTPException(status_code=422, detail="Informe ao menos um item para a OV.")

    saldo = _saldo_demanda(db, d)
    for it in payload.itens:
        pid = str(it.produto_id)
        if it.qtd_solicitada > saldo.get(pid, 0.0) + 0.001:
            raise HTTPException(status_code=422, detail=f"Quantidade acima do saldo do item (saldo {round(saldo.get(pid, 0.0))}).")

    ped = pedido_service.criar_pedido(
        PedidoCreate(
            numero_pedido=payload.numero_pedido,
            cliente_id=d["cliente_id"],
            tipo_frete=payload.tipo_frete or "FOB",
            tipo_operacao="VENDA_NORMAL",
            canal=payload.canal or d.get("canal"),
            local_entrega=payload.local_entrega,
            data_prevista_entrega=payload.data_prevista_entrega,
            itens=payload.itens,
        ),
        usuario,
    )
    ovs = list(d.get("ovs") or [])
    if not any(o.get("id") == ped["id"] for o in ovs):
        ovs.append({"id": ped["id"], "numero": ped["numero_pedido"]})
    update = {"ovs": ovs, "atualizado_em": _agora()}
    if not d.get("gerado_id"):
        update.update({
            "gerado_tipo": "PEDIDO",
            "gerado_id": ped["id"],
            "gerado_ref": ped["numero_pedido"],
            "ref_externa": ped["numero_pedido"],
        })
    if _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa")) == "RECEBIDO":
        update["etapa"] = "PROCESSANDO"
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    res = obter_demanda(demanda_id)
    res["ov_gerada_id"] = ped.get("id")
    res["ov_gerada_ref"] = ped.get("numero_pedido")
    return res


def atualizar_demanda(demanda_id: str, payload: DemandaUpdate) -> dict:
    db = get_service_db()
    atual = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")

    update: dict = {"atualizado_em": _agora()}
    if payload.tipo_operacao is not None:
        if payload.tipo_operacao not in TIPOS:
            raise HTTPException(status_code=422, detail="Tipo de operação inválido")
        update["tipo_operacao"] = payload.tipo_operacao
    if payload.etapa is not None:
        etapa = _ETAPA_LEGADA.get(payload.etapa, payload.etapa)
        if etapa not in ETAPAS:
            raise HTTPException(status_code=422, detail="Etapa inválida")
        update["etapa"] = etapa
        # Concluir é só marcar como feito (opcionalmente com o nº do doc do D365).
        update["concluido_em"] = _agora() if etapa == "CONCLUIDO" else None
    if payload.ref_externa is not None:
        update["ref_externa"] = payload.ref_externa.strip() or None
    if payload.numero is not None:
        update["numero"] = payload.numero.strip() or None
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.canal is not None:
        update["canal"] = payload.canal or None
    if payload.prazo is not None:
        update["prazo"] = payload.prazo.isoformat()
    if payload.prioridade is not None:
        update["prioridade"] = payload.prioridade
    if payload.observacao is not None:
        update["observacao"] = payload.observacao
    if payload.responsavel_id is not None:
        update["responsavel_id"] = str(payload.responsavel_id)
    if payload.itens is not None:
        update["itens"] = _itens_json(payload.itens)

    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def excluir_demanda(demanda_id: str) -> dict:
    db = get_service_db()
    db.table("licitacao_demandas").update({"ativo": False, "atualizado_em": _agora()})\
        .eq("id", demanda_id).execute()
    return {"ok": True}


def _itens_pedido(itens, rotulo: str) -> list:
    """Converte os itens (produto_id + qtd) para ItemPedidoCreate, validando."""
    validos = [it for it in itens if it.produto_id and float(it.qtd or 0) > 0]
    if not validos:
        raise HTTPException(
            status_code=422,
            detail=f"Informe ao menos um item (produto e quantidade) para {rotulo}.",
        )
    return [ItemPedidoCreate(produto_id=it.produto_id, qtd_solicitada=float(it.qtd)) for it in validos]


def concluir_demanda(demanda_id: str, payload: DemandaConcluir, usuario: UsuarioOut) -> dict:
    from app.services import licitacao_service, pedido_service

    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    if d.get("gerado_id"):
        raise HTTPException(status_code=400, detail="Esta demanda já foi concluída e gerou um registro.")

    tipo = d.get("tipo_operacao")
    cliente_id = d.get("cliente_id")
    canal = payload.canal or d.get("canal")

    # Itens: usa os informados na conclusão; se vazios, cai nos itens da triagem.
    itens_src = payload.itens
    if not itens_src and d.get("itens"):
        from app.models.schemas import DemandaItem
        itens_src = [DemandaItem(**it) for it in d["itens"]]

    gerado_tipo = gerado_id = gerado_ref = None

    if tipo in ("VENDA_DIRETA", "CONSIGNACAO"):
        # Ambos criam um CONTRATO (empenho) com as quantidades totais do pregão/ata.
        # Venda direta é baixada por OVs parciais; consignação por comunicado de uso.
        if not payload.numero or not payload.numero.strip():
            raise HTTPException(status_code=422, detail="Informe o número do contrato/empenho.")
        itens_emp = [it for it in itens_src if it.produto_id and float(it.qtd or 0) > 0]
        if not itens_emp:
            raise HTTPException(status_code=422, detail="Informe os itens do contrato (produto, quantidade e valor).")
        emp = licitacao_service.criar_empenho(
            EmpenhoCreate(
                numero=payload.numero.strip(),
                cliente_id=cliente_id,
                tipo=tipo,
                canal=canal,
                data_empenho=payload.data_empenho,
                vigencia=payload.vigencia,
                observacao=d.get("observacao"),
                itens=[EmpenhoItemCreate(produto_id=it.produto_id, qtd_empenhada=float(it.qtd),
                                         valor_unitario=float(it.valor or 0)) for it in itens_emp],
            )
        )
        gerado_tipo, gerado_id, gerado_ref = "CONTRATO", emp.get("id"), emp.get("numero")

    elif tipo == "COMUNICADO_USO":
        if not payload.numero_pedido or not payload.numero_pedido.strip():
            raise HTTPException(status_code=422, detail="Informe o número do lançamento (comunicado).")
        if not payload.numero_nf or not payload.numero_nf.strip():
            raise HTTPException(status_code=422, detail="Informe o número da NF.")
        if not payload.valor_nf or float(payload.valor_nf) <= 0:
            raise HTTPException(status_code=422, detail="Informe o valor da NF (maior que zero).")

        if payload.empenho_id:
            # Baixa saldo de um empenho consignado existente.
            licitacao_service.registrar_consumo(
                str(payload.empenho_id),
                ConsumoEmpenhoCreate(
                    numero_pedido=payload.numero_pedido.strip().upper(),
                    numero_nf=payload.numero_nf.strip(),
                    valor_nf=float(payload.valor_nf),
                    data_faturamento=payload.data_faturamento,
                    canal=canal,
                    itens=_itens_pedido(itens_src, "o comunicado de uso"),
                ),
                usuario,
            )
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", str(payload.empenho_id), payload.numero_pedido.strip().upper()
        else:
            # Comunicado avulso (consignado não rastreado no painel).
            com = pedido_service.criar_comunicado_uso(
                ComunicadoUsoCreate(
                    numero_pedido=payload.numero_pedido.strip().upper(),
                    cliente_id=cliente_id,
                    numero_nf=payload.numero_nf.strip(),
                    valor_nf=float(payload.valor_nf),
                    canal=canal,
                    data_faturamento=payload.data_faturamento,
                    itens=[ItemPedidoCreate(produto_id=it.produto_id, qtd_solicitada=float(it.qtd))
                           for it in itens_src if it.produto_id and float(it.qtd or 0) > 0],
                ),
                usuario,
            )
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", com.get("id"), com.get("numero_pedido")
    else:
        raise HTTPException(status_code=422, detail="Tipo de operação da demanda inválido.")

    db.table("licitacao_demandas").update({
        "etapa": "CONCLUIDO",
        "gerado_tipo": gerado_tipo,
        "gerado_id": gerado_id,
        "gerado_ref": gerado_ref,
        "canal": canal,
        "numero": payload.numero.strip() if payload.numero else d.get("numero"),
        "concluido_em": _agora(),
        "atualizado_em": _agora(),
    }).eq("id", demanda_id).execute()

    return obter_demanda(demanda_id)
