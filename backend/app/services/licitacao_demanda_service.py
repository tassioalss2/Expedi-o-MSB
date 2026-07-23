"""Painel de demandas de licitação — triagem visual (Kanban) das operações que
chegam por e-mail (venda direta, consignação, comunicado de uso).

Cada demanda é um card que anda pelas etapas NOVO → ANALISE → PROCESSANDO →
CONCLUIDO. Ao concluir, o app gera automaticamente o artefato correspondente:
- VENDA_DIRETA  → cria a OV no fluxo logístico
- CONSIGNACAO   → cria o empenho
- COMUNICADO_USO→ registra o comunicado de uso (baixando saldo de um empenho, se houver)
"""
from datetime import date
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

ETAPAS = ["RECEBIDO", "PROCESSANDO", "AGUARDANDO_ESTOQUE", "COTACAO_FRETE", "OV_GERADA", "NF_ENVIADA", "CONCLUIDO"]
# Etapas antigas → novas (compatibilidade com registros já criados)
_ETAPA_LEGADA = {"NOVO": "RECEBIDO", "ANALISE": "RECEBIDO"}
# Etapas terminais (saem do painel do dia seguinte, vão para o histórico)
ETAPAS_FINAIS = {"NF_ENVIADA", "CONCLUIDO"}
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
        "numero_pregao": d.get("numero_pregao"),
        "numero": d.get("numero"),
        "cliente_id": d.get("cliente_id"),
        "cliente": (d.get("clientes") or {}).get("nome") if d.get("clientes") else None,
        "canal": d.get("canal"),
        "prazo": d.get("prazo"),
        "prioridade": d.get("prioridade") or "NORMAL",
        "observacao": d.get("observacao"),
        "responsavel_id": d.get("responsavel_id"),
        "nome_paciente": d.get("nome_paciente"),
        "prontuario": d.get("prontuario"),
        "numero_nf": d.get("numero_nf"),
        "data_procedimento": d.get("data_procedimento"),
        "itens": d.get("itens") or [],
        "gerado_tipo": d.get("gerado_tipo"),
        "gerado_id": d.get("gerado_id"),
        "gerado_ref": d.get("gerado_ref"),
        "frete": d.get("frete"),
        "nf": d.get("nf"),
        "estoque": d.get("estoque"),
        "ovs": d.get("ovs") or [],
        "ovs_detalhe": None,
        "ov_status": None,
        "ov_itens": None,
        "criado_em": d.get("criado_em"),
        "atualizado_em": d.get("atualizado_em"),
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
        for p in db.table("pedidos").select("id, numero_pedido, status, numero_nf").in_("id", lote).execute().data:
            status_map[p["id"]] = {"numero": p.get("numero_pedido"), "status": p.get("status"), "nf": p.get("numero_nf")}
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
            "nf": (status_map.get(i) or {}).get("nf"),
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
        if d["etapa"] not in ETAPAS_FINAIS:
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
        if etapa in ETAPAS_FINAIS and ce:
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
           if d["etapa"] in ETAPAS_FINAIS and d.get("concluido_em") and _data_brt(d["concluido_em"]) == alvo]
    _anexar_ov_status(db, out)
    return out


def historico_buscar(termo: str) -> list:
    """Busca em TODAS as demandas ativas — concluídas ou ainda em andamento —
    por pregão, NE, AF, paciente, prontuário, cliente ou OV. Não se limita ao
    que já foi concluído: se alguém já está processando o mesmo caso, o
    operador precisa ver isso ANTES de criar de novo, senão a busca não evita
    a duplicidade que deveria evitar."""
    q = (termo or "").strip().lower()
    if not q:
        return []
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("criado_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    _anexar_ov_status(db, demandas)

    def casa(d: dict) -> bool:
        campos = [d.get("numero_pregao"), d.get("numero"), d.get("cliente"),
                  d.get("ref_externa"), d.get("gerado_ref"),
                  d.get("nome_paciente"), d.get("prontuario"), d.get("numero_nf")]
        for ov in (d.get("ovs_detalhe") or []):
            campos.append(ov.get("numero"))
        return any(q in str(c).lower() for c in campos if c)

    out = [d for d in demandas if casa(d)]
    out.sort(key=lambda d: d.get("concluido_em") or d.get("atualizado_em") or d.get("criado_em") or "", reverse=True)
    return out[:100]


def relatorio(tipo: Optional[str] = None, canal: Optional[str] = None,
              data_inicio: Optional[str] = None, data_fim: Optional[str] = None) -> list:
    """Relatório completo — tudo que já foi feito de venda direta, comunicado de
    uso e consignação, filtrável por tipo/canal/período. Substitui o controle em
    planilha: cada linha traz pregão/AF, paciente/prontuário (comunicado), NF(s)
    e valor total, com a data de referência sendo a de conclusão (ou criação,
    se ainda em andamento)."""
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("criado_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    _anexar_ov_status(db, demandas)

    for d in demandas:
        d["data_ref"] = (d.get("concluido_em") or d.get("criado_em") or "")[:10]
        d["valor_total"] = sum(float(it.get("qtd") or 0) * float(it.get("valor") or 0) for it in (d.get("itens") or []))

    def dentro(d: dict) -> bool:
        if tipo and d["tipo_operacao"] != tipo:
            return False
        if canal and d.get("canal") != canal:
            return False
        if data_inicio and d["data_ref"] < data_inicio:
            return False
        if data_fim and d["data_ref"] > data_fim:
            return False
        return True

    out = [d for d in demandas if dentro(d)]
    out.sort(key=lambda d: d["data_ref"], reverse=True)
    return out


def _garantir_contrato_vd(db, d: dict) -> str | None:
    """Garante que exista o contrato (empenho) de uma venda direta, criando-o com
    as quantidades totais da triagem se ainda não houver. Idempotente: se já
    existe um empenho com o mesmo número, reusa. Devolve o empenho_id (ou None)."""
    if d.get("tipo_operacao") != "VENDA_DIRETA":
        return None
    contrato_num = (d.get("numero") or "").strip() or (d.get("numero_pregao") or "").strip()
    if not contrato_num:
        return None
    existente = db.table("empenhos").select("id").eq("numero", contrato_num).eq("ativo", True).execute().data
    if existente:
        return existente[0]["id"]
    itens_emp = [EmpenhoItemCreate(produto_id=it.get("produto_id"),
                                   qtd_empenhada=float(it.get("qtd") or 0),
                                   valor_unitario=float(it.get("valor") or 0))
                 for it in (d.get("itens") or [])
                 if it.get("produto_id") and float(it.get("qtd") or 0) > 0]
    if not itens_emp:
        return None
    from app.services import licitacao_service
    emp = licitacao_service.criar_empenho(EmpenhoCreate(
        numero=contrato_num,
        numero_pregao=(d.get("numero_pregao") or "").strip() or None,
        cliente_id=d["cliente_id"], tipo="VENDA_DIRETA",
        canal=d.get("canal"), vigencia=None, itens=itens_emp,
    ))
    return emp.get("id")


def criar_demanda(payload: DemandaCreate) -> dict:
    if payload.tipo_operacao not in TIPOS:
        raise HTTPException(status_code=422, detail="Tipo de operação inválido")
    db = get_service_db()
    num = (payload.numero or "").strip()
    # Comunicado de uso é regido pela AF + paciente + prontuário — obrigatórios
    # para rastreabilidade (evita o time processar o mesmo caso duas vezes).
    if payload.tipo_operacao == "COMUNICADO_USO":
        if not num:
            raise HTTPException(status_code=422, detail="Informe a AF (Autorização de Fornecimento).")
        if not (payload.nome_paciente or "").strip():
            raise HTTPException(status_code=422, detail="Informe o nome do paciente.")
        if not (payload.prontuario or "").strip():
            raise HTTPException(status_code=422, detail="Informe o prontuário.")
        if not (payload.numero_nf or "").strip():
            raise HTTPException(status_code=422, detail="Informe o número da NF.")
        if not payload.data_procedimento:
            raise HTTPException(status_code=422, detail="Informe a data do procedimento.")
    elif payload.tipo_operacao in ("VENDA_DIRETA", "CONSIGNACAO") and not num:
        raise HTTPException(status_code=422, detail="Informe a Nota de Empenho (NE).")
    # Anti-duplicidade: o mesmo número (empenho/AF/pregão) não pode ter duas
    # demandas ativas — evita o time processar o mesmo pedido duas vezes.
    if num:
        dup = db.table("licitacao_demandas").select("id, etapa, clientes(nome)")\
            .eq("ativo", True).eq("numero", num).execute().data
        if dup:
            cli = (dup[0].get("clientes") or {}).get("nome") or "cliente não informado"
            campo = "AF" if payload.tipo_operacao == "COMUNICADO_USO" else "número"
            raise HTTPException(
                status_code=409,
                detail=f"Já existe uma demanda ativa com o {campo} '{num}' ({cli}). Confira no painel/histórico antes de criar — risco de processar duas vezes.",
            )
    row = db.table("licitacao_demandas").insert({
        "tipo_operacao": payload.tipo_operacao,
        "etapa": "RECEBIDO",
        "numero_pregao": (payload.numero_pregao or "").strip() or None,
        "numero": num or None,
        "cliente_id": str(payload.cliente_id),
        "canal": payload.canal,
        "prazo": payload.prazo.isoformat() if payload.prazo else None,
        "prioridade": payload.prioridade or "NORMAL",
        "observacao": payload.observacao,
        "itens": _itens_json(payload.itens),
        "nome_paciente": (payload.nome_paciente or "").strip() or None,
        "prontuario": (payload.prontuario or "").strip() or None,
        "numero_nf": (payload.numero_nf or "").strip() or None,
        "data_procedimento": payload.data_procedimento.isoformat() if payload.data_procedimento else None,
        "ativo": True,
    }).execute().data[0]
    # Venda direta "ganhou o pregão" → já cria o contrato com as quantidades
    # totais (o card segue no kanban; o contrato aparece na aba Contratos).
    # Falha aqui não bloqueia a criação da demanda.
    try:
        _garantir_contrato_vd(db, obter_demanda(row["id"]))
    except Exception:
        pass
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


# tipo_operacao da OV no fluxo logístico conforme o tipo da demanda
_TIPO_OP_OV = {"VENDA_DIRETA": "VENDA_NORMAL", "CONSIGNACAO": "CONSIGNADO"}


def gerar_ov_saldo(demanda_id: str, payload, usuario: UsuarioOut) -> dict:
    """Gera uma OV no fluxo logístico com o saldo (ou parte dele) de uma venda
    direta / consignação. A OV é vinculada à demanda; o saldo restante continua
    rastreado. Se payload.concluir, a demanda também é marcada como concluída
    (fluxo padrão: processa no D365, depois gera a OV ao concluir)."""
    from app.services import pedido_service

    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    tipo_demanda = d.get("tipo_operacao")
    if tipo_demanda not in _TIPO_OP_OV:
        raise HTTPException(status_code=400, detail="Gerar OV vale só para venda direta e consignação.")
    if not payload.itens:
        raise HTTPException(status_code=422, detail="Informe ao menos um item para a OV.")

    saldo = _saldo_demanda(db, d)
    # Preço unitário digitado na triagem segue junto para a OV (sugere o valor da
    # NF no faturamento sem redigitar).
    preco_triagem = {it.get("produto_id"): float(it.get("valor") or 0)
                     for it in (d.get("itens") or []) if it.get("produto_id")}
    for it in payload.itens:
        pid = str(it.produto_id)
        if it.qtd_solicitada > saldo.get(pid, 0.0) + 0.001:
            raise HTTPException(status_code=422, detail=f"Quantidade acima do saldo do item (saldo {round(saldo.get(pid, 0.0))}).")
        if it.valor_unitario is None and preco_triagem.get(pid):
            it.valor_unitario = preco_triagem[pid]

    # Frete cotado na demanda vai para a OV (transportadora + tipo). O valor cotado
    # entra nas observações (o valor de frete formal é confirmado no faturamento).
    frete = d.get("frete") or {}
    transp_id = getattr(payload, "transportadora_id", None) or frete.get("transportadora_id")
    valor_frete = getattr(payload, "valor_frete", None)
    if valor_frete is None:
        valor_frete = frete.get("valor")
    obs = None
    if valor_frete or frete.get("transportadora_nome"):
        partes = []
        if frete.get("transportadora_nome"):
            partes.append(f"Transportadora: {frete.get('transportadora_nome')}")
        if valor_frete:
            partes.append(f"Frete cotado: R$ {float(valor_frete):.2f}")
        if frete.get("prazo_dias"):
            partes.append(f"Prazo: {frete.get('prazo_dias')} dia(s)")
        obs = " · ".join(partes)

    # Contrato automático: se ainda não existe um contrato (empenho) para esta
    # venda direta, cria um por baixo dos panos com as quantidades totais da
    # triagem — assim o saldo é rastreado sem o operador dar um passo extra.
    empenho_id = _garantir_contrato_vd(db, d) if tipo_demanda == "VENDA_DIRETA" else None

    ped = pedido_service.criar_pedido(
        PedidoCreate(
            numero_pedido=payload.numero_pedido,
            cliente_id=d["cliente_id"],
            transportadora_id=transp_id,
            tipo_frete=payload.tipo_frete or "CIF_SEM_VALOR",
            tipo_operacao=_TIPO_OP_OV[tipo_demanda],
            canal=payload.canal or d.get("canal"),
            local_entrega=payload.local_entrega,
            data_prevista_entrega=payload.data_prevista_entrega,
            observacoes=obs,
            valor_frete=float(valor_frete) if valor_frete else None,
            empenho_id=empenho_id,
            itens=payload.itens,
        ),
        usuario,
    )
    ovs = list(d.get("ovs") or [])
    if not any(o.get("id") == ped["id"] for o in ovs):
        ovs.append({"id": ped["id"], "numero": ped["numero_pedido"]})
    update = {"ovs": ovs, "etapa": "OV_GERADA", "atualizado_em": _agora()}
    if not d.get("gerado_id"):
        update.update({
            "gerado_tipo": "PEDIDO",
            "gerado_id": ped["id"],
            "gerado_ref": ped["numero_pedido"],
            "ref_externa": ped["numero_pedido"],
        })
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    res = obter_demanda(demanda_id)
    res["ov_gerada_id"] = ped.get("id")
    res["ov_gerada_ref"] = ped.get("numero_pedido")
    return res


def registrar_frete(demanda_id: str, payload) -> dict:
    """Cotação de frete (CIF sem valor). Guarda transportadora + valor + prazo na
    demanda; esses dados vão para a OV ao gerá-la. Avança a etapa para Cotação de frete."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    frete = {
        "transportadora_id": str(payload.transportadora_id) if payload.transportadora_id else None,
        "transportadora_nome": (payload.transportadora_nome or "").strip() or None,
        "valor": float(payload.valor) if payload.valor is not None else None,
        "prazo_dias": int(payload.prazo_dias) if payload.prazo_dias is not None else None,
        "tipo_frete": payload.tipo_frete or "CIF_SEM_VALOR",
        "observacao": (payload.observacao or "").strip() or None,
    }
    update = {"frete": frete, "atualizado_em": _agora()}
    if _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa")) in ("RECEBIDO", "PROCESSANDO", "OV_GERADA"):
        update["etapa"] = "COTACAO_FRETE"
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def enviar_nf(demanda_id: str, payload, usuario: UsuarioOut) -> dict:
    """Registra o envio da NF ao cliente — fechamento da demanda (etapa NF enviada)."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    nf = {
        "numero": (payload.numero or "").strip() or None,
        "enviada_em": payload.enviada_em.isoformat() if payload.enviada_em else _data_brt(_agora()),
        "enviada_por": getattr(usuario, "nome", None) or getattr(usuario, "email", None),
        "observacao": (payload.observacao or "").strip() or None,
    }
    db.table("licitacao_demandas").update({
        "nf": nf,
        "etapa": "NF_ENVIADA",
        "concluido_em": _agora(),
        "atualizado_em": _agora(),
    }).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def marcar_sem_estoque(demanda_id: str, payload) -> dict:
    """Sinaliza que o pedido não tem estoque disponível. O card vai para a coluna
    'Aguardando estoque (PCP)' e NÃO sai do painel — fica visível até o estoque
    chegar, para o time nunca esquecer (risco de multa contratual). Guarda a
    previsão informada pelo PCP e (opcionalmente) o prazo de entrega do contrato,
    que é cruzado com a previsão para alertar risco de multa."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    etapa_atual = _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa"))
    anterior = (d.get("estoque") or {}).get("etapa_anterior")
    estoque = {
        "em_falta": True,
        "previsao_pcp": payload.previsao_pcp.isoformat() if payload.previsao_pcp else None,
        "itens_faltantes": [s for s in (payload.itens_faltantes or []) if (s or "").strip()],
        "observacao": (payload.observacao or "").strip() or None,
        # Guarda de onde veio para conseguir voltar quando o estoque chegar.
        "etapa_anterior": etapa_atual if etapa_atual != "AGUARDANDO_ESTOQUE" else (anterior or "PROCESSANDO"),
        "registrado_em": _agora(),
    }
    update = {"estoque": estoque, "etapa": "AGUARDANDO_ESTOQUE", "atualizado_em": _agora()}
    # Permite registrar/atualizar o prazo contratual no mesmo passo (hoje muitos
    # não têm o prazo preenchido, e ele é a base do alerta de multa).
    if getattr(payload, "prazo", None) is not None:
        update["prazo"] = payload.prazo.isoformat()
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def liberar_estoque(demanda_id: str, payload=None) -> dict:
    """Estoque chegou (ou PCP produziu). Devolve o card ao fluxo normal — volta
    para a etapa em que estava antes de faltar estoque (padrão: em processamento).
    Mantém o histórico do que faltou."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    est = dict(d.get("estoque") or {})
    destino = est.get("etapa_anterior") or "PROCESSANDO"
    if destino not in ETAPAS or destino in ETAPAS_FINAIS or destino == "AGUARDANDO_ESTOQUE":
        destino = "PROCESSANDO"
    est["em_falta"] = False
    est["liberado_em"] = _agora()
    if payload is not None and getattr(payload, "observacao", None):
        est["observacao_liberacao"] = (payload.observacao or "").strip() or None
    db.table("licitacao_demandas").update({
        "estoque": est,
        "etapa": destino,
        "atualizado_em": _agora(),
    }).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


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
        # Etapas finais registram a data de conclusão (para o histórico do dia).
        update["concluido_em"] = _agora() if etapa in ETAPAS_FINAIS else None
    if payload.ref_externa is not None:
        update["ref_externa"] = payload.ref_externa.strip() or None
    if payload.numero_pregao is not None:
        update["numero_pregao"] = payload.numero_pregao.strip() or None
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
    etapa_atual0 = _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa"))
    if d.get("gerado_id") and etapa_atual0 in ETAPAS_FINAIS:
        raise HTTPException(status_code=400, detail="Esta demanda já foi concluída e gerou um registro.")
    # Reaberta (etapa voltou pra antes de concluído) depois de já ter gerado um
    # registro — corrige o que já existe em vez de criar de novo (senão duplica
    # ou esbarra no "já existe um lançamento com esse número").
    reabrindo = bool(d.get("gerado_id")) and etapa_atual0 not in ETAPAS_FINAIS

    tipo = d.get("tipo_operacao")
    if reabrindo and tipo != "COMUNICADO_USO":
        raise HTTPException(status_code=400, detail="Este contrato já foi criado — para corrigir, edite pela aba Contratos.")
    # Cliente confirmado na conclusão prevalece (obrigatório no comunicado de uso).
    cliente_id = str(payload.cliente_id) if getattr(payload, "cliente_id", None) else d.get("cliente_id")
    if not cliente_id:
        raise HTTPException(status_code=422, detail="Informe o cliente.")
    canal = payload.canal or d.get("canal")

    # Itens: usa os informados na conclusão; se vazios, cai nos itens da triagem.
    itens_src = payload.itens
    if not itens_src and d.get("itens"):
        from app.models.schemas import DemandaItem
        itens_src = [DemandaItem(**it) for it in d["itens"]]

    gerado_tipo = gerado_id = gerado_ref = None
    etapa_final = "CONCLUIDO"
    ovs_final = None

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
                numero_pregao=(payload.numero_pregao or "").strip() or d.get("numero_pregao"),
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

        # Atalho de entrega única (venda direta): já gera a OV cheia baixando todo
        # o saldo. A demanda segue no painel em "OV gerada" para cotar frete/enviar NF.
        if getattr(payload, "gerar_ov", False) and tipo == "VENDA_DIRETA":
            if not payload.numero_pedido or not payload.numero_pedido.strip():
                raise HTTPException(status_code=422, detail="Informe o número da OV para gerar a entrega junto.")
            from app.models.schemas import EntregaVendaDiretaCreate
            itens_ov = [ItemPedidoCreate(
                produto_id=it["produto_id"],
                qtd_solicitada=float(it.get("qtd_empenhada") or it.get("qtd_saldo") or 0),
                valor_unitario=(float(it.get("valor_unitario")) if it.get("valor_unitario") else None),
            ) for it in (emp.get("itens") or []) if it.get("produto_id") and float(it.get("qtd_empenhada") or 0) > 0]
            entrega = licitacao_service.registrar_entrega(
                emp["id"],
                EntregaVendaDiretaCreate(
                    numero_pedido=payload.numero_pedido.strip().upper(),
                    tipo_frete=payload.tipo_frete or "CIF_SEM_VALOR",
                    canal=canal,
                    data_prevista_entrega=payload.data_prevista_entrega or _hoje_brt(),
                    local_entrega=payload.local_entrega,
                    itens=itens_ov,
                ),
                usuario,
            )
            # A OV vira um card próprio no kanban (criado por registrar_entrega),
            # que acompanha frete/NF. O contrato (esta demanda) fica concluído.

    elif tipo == "COMUNICADO_USO":
        if not payload.numero_pedido or not payload.numero_pedido.strip():
            raise HTTPException(status_code=422, detail="Informe o número do lançamento (comunicado).")
        numped = payload.numero_pedido.strip().upper()

        # AF/paciente/prontuário: o que rege o comunicado. Payload (editado na
        # conclusão) prevalece; senão usa o que já foi capturado na triagem.
        af = (payload.numero or "").strip() or d.get("numero")
        nome_paciente = (payload.nome_paciente or "").strip() or d.get("nome_paciente")
        prontuario = (payload.prontuario or "").strip() or d.get("prontuario")
        if not af:
            raise HTTPException(status_code=422, detail="Informe a AF (Autorização de Fornecimento).")
        if not nome_paciente:
            raise HTTPException(status_code=422, detail="Informe o nome do paciente.")
        if not prontuario:
            raise HTTPException(status_code=422, detail="Informe o prontuário.")

        # Se o comunicado com esse número já existe (faturado no D365/app), apenas
        # vincula a demanda a ele e conclui — não lança de novo (evita duplicidade).
        # Não vale quando a demanda foi reaberta pra corrigir algo — nesse caso o
        # "existente" é o próprio lançamento que ela já gerou, e o objetivo é
        # atualizar os dados errados, não só vincular de novo.
        existente = None if reabrindo else db.table("pedidos").select("id, numero_pedido")\
            .eq("numero_pedido", numped).neq("status", "CANCELADO").limit(1).execute().data
        if existente:
            p = existente[0]
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", p["id"], p["numero_pedido"]
            db.table("licitacao_demandas").update({
                "etapa": "CONCLUIDO",
                "gerado_tipo": gerado_tipo,
                "gerado_id": gerado_id,
                "gerado_ref": gerado_ref,
                "cliente_id": cliente_id,
                "canal": canal,
                "numero": af,
                "nome_paciente": nome_paciente,
                "prontuario": prontuario,
                "concluido_em": _agora(),
                "atualizado_em": _agora(),
            }).eq("id", demanda_id).execute()
            return obter_demanda(demanda_id)

        numero_nf = (payload.numero_nf or "").strip() or d.get("numero_nf")
        data_procedimento = payload.data_procedimento or (
            date.fromisoformat(d["data_procedimento"]) if d.get("data_procedimento") else None
        )
        if not numero_nf:
            raise HTTPException(status_code=422, detail="Informe o número da NF.")
        if not payload.valor_nf or float(payload.valor_nf) <= 0:
            raise HTTPException(status_code=422, detail="Informe o valor da NF (maior que zero).")

        if reabrindo:
            # Já tinha gerado o lançamento antes (demanda reaberta pra corrigir
            # algo errado) — atualiza o registro existente em vez de criar de
            # novo, senão duplica ou esbarra no "já existe lançamento com esse número".
            ped = db.table("pedidos").select("id, numero_pedido")\
                .eq("numero_pedido", d.get("gerado_ref") or numped).limit(1).execute().data
            if not ped:
                raise HTTPException(status_code=404, detail="O lançamento gerado anteriormente não foi encontrado — não dá para atualizar.")
            pid = ped[0]["id"]
            db.table("pedidos").update({
                "numero_nf": numero_nf,
                "valor_nf": float(payload.valor_nf),
                "valor_produtos": float(payload.valor_nf),
                "af": af,
                "nome_paciente": nome_paciente,
                "prontuario": prontuario,
                "data_procedimento": data_procedimento.isoformat() if data_procedimento else None,
                "canal": canal,
                "atualizado_em": _agora(),
            }).eq("id", pid).execute()
            itens_corrigidos = [it for it in itens_src if it.produto_id and float(it.qtd or 0) > 0]
            if itens_corrigidos:
                db.table("itens_pedido").delete().eq("pedido_id", pid).execute()
                db.table("itens_pedido").insert([{
                    "pedido_id": pid, "produto_id": str(it.produto_id),
                    "qtd_solicitada": float(it.qtd), "status_item": "OK",
                } for it in itens_corrigidos]).execute()
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", pid, ped[0]["numero_pedido"]
        elif payload.empenho_id:
            # Baixa saldo de um empenho consignado existente.
            licitacao_service.registrar_consumo(
                str(payload.empenho_id),
                ConsumoEmpenhoCreate(
                    numero_pedido=payload.numero_pedido.strip().upper(),
                    numero_nf=numero_nf,
                    valor_nf=float(payload.valor_nf),
                    data_faturamento=payload.data_faturamento,
                    canal=canal,
                    itens=_itens_pedido(itens_src, "o comunicado de uso"),
                    af=af, nome_paciente=nome_paciente, prontuario=prontuario,
                    data_procedimento=data_procedimento,
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
                    numero_nf=numero_nf,
                    valor_nf=float(payload.valor_nf),
                    canal=canal,
                    data_faturamento=payload.data_faturamento,
                    af=af, nome_paciente=nome_paciente, prontuario=prontuario,
                    data_procedimento=data_procedimento,
                    itens=[ItemPedidoCreate(produto_id=it.produto_id, qtd_solicitada=float(it.qtd))
                           for it in itens_src if it.produto_id and float(it.qtd or 0) > 0],
                ),
                usuario,
            )
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", com.get("id"), com.get("numero_pedido")
    else:
        raise HTTPException(status_code=422, detail="Tipo de operação da demanda inválido.")

    update_final = {
        "etapa": etapa_final,
        "gerado_tipo": gerado_tipo,
        "gerado_id": gerado_id,
        "gerado_ref": gerado_ref,
        "cliente_id": cliente_id,
        "canal": canal,
        "numero": payload.numero.strip() if payload.numero else d.get("numero"),
        "nome_paciente": (payload.nome_paciente or "").strip() or d.get("nome_paciente"),
        "prontuario": (payload.prontuario or "").strip() or d.get("prontuario"),
        "numero_nf": (payload.numero_nf or "").strip() or d.get("numero_nf"),
        "data_procedimento": payload.data_procedimento.isoformat() if payload.data_procedimento else d.get("data_procedimento"),
        "concluido_em": _agora() if etapa_final in ETAPAS_FINAIS else None,
        "atualizado_em": _agora(),
    }
    if ovs_final is not None:
        update_final["ovs"] = ovs_final
    db.table("licitacao_demandas").update(update_final).eq("id", demanda_id).execute()

    return obter_demanda(demanda_id)
