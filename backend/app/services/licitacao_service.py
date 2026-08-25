"""Gestão de Licitações — empenhos consignados e consumo via comunicado de uso."""
from datetime import date
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import (
    ComunicadoUsoCreate,
    ConsumoEmpenhoCreate,
    EmpenhoCreate,
    EntregaVendaDiretaCreate,
    UsuarioOut,
)
from app.services import pedido_service


def _status(vigencia: Optional[str], saldo_un: float, empenhado_un: float) -> str:
    if empenhado_un > 0 and saldo_un <= 0.001:
        return "CONCLUIDO"
    vencido = bool(vigencia and vigencia < pedido_service._hoje_brt().isoformat())
    if vencido:
        return "VENCIDO"
    if saldo_un < empenhado_un:
        return "PARCIAL"
    return "ABERTO"


# A remessa de consignado (OV do tipo CONSIGNADO) tira o material do estoque e
# manda para o cliente, mas NÃO cumpre o contrato: quem cumpre é o comunicado de
# uso, quando o material é usado no paciente. Contar a remessa como consumo
# deixaria o contrato 100% consumido no instante em que o material sai, e os
# comunicados seguintes não achariam saldo.
#
# Na venda direta é o contrário, e por isso ela não entra nesta lista: ali,
# entregar É cumprir o contrato.
_NAO_CONSOME_CONTRATO = ("CONSIGNADO",)


def _consumo_por_empenho(db, empenho_ids: list[str]) -> dict:
    """{empenho_id: {produto_id: qtd_consumida}}.

    Consumo é o que baixa o contrato de verdade: entrega de venda direta e
    comunicado de uso. Remessa de consignado fica de fora — ver acima."""
    consumo: dict = {}
    if not empenho_ids:
        return consumo
    for i in range(0, len(empenho_ids), 80):
        lote = empenho_ids[i:i + 80]
        peds = db.table("pedidos").select("id, empenho_id, tipo_operacao, itens_pedido(produto_id, qtd_solicitada)")\
            .in_("empenho_id", lote).neq("status", "CANCELADO").execute().data
        for p in peds:
            emp = p.get("empenho_id")
            if not emp:
                continue
            if (p.get("tipo_operacao") or "") in _NAO_CONSOME_CONTRATO:
                continue
            alvo = consumo.setdefault(emp, {})
            for it in (p.get("itens_pedido") or []):
                pid = it.get("produto_id")
                if pid:
                    alvo[pid] = alvo.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)
    return consumo


def _remessa_por_empenho(db, empenho_ids: list[str]) -> dict:
    """{empenho_id: {produto_id: qtd_remetida}} — o que ja saiu em remessa.

    So faz sentido em contrato de consignacao, onde remeter e consumir sao dois
    momentos diferentes. E este numero, cruzado com o consumo, que responde
    "quanto material meu esta na mao do cliente" — pergunta que hoje nao tem
    resposta em lugar nenhum."""
    remessa: dict = {}
    if not empenho_ids:
        return remessa
    for i in range(0, len(empenho_ids), 80):
        lote = empenho_ids[i:i + 80]
        peds = db.table("pedidos").select(
            "id, empenho_id, tipo_operacao, itens_pedido(produto_id, qtd_solicitada)"
        ).in_("empenho_id", lote).neq("status", "CANCELADO").execute().data
        for p in peds:
            emp = p.get("empenho_id")
            if not emp or (p.get("tipo_operacao") or "") not in _NAO_CONSOME_CONTRATO:
                continue
            alvo = remessa.setdefault(emp, {})
            for it in (p.get("itens_pedido") or []):
                pid = it.get("produto_id")
                if pid:
                    alvo[pid] = alvo.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)
    return remessa


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

    dados = {
        "numero": payload.numero,
        "numero_pregao": (payload.numero_pregao or "").strip() or None,
        "cliente_id": str(payload.cliente_id),
        "tipo": payload.tipo or "CONSIGNACAO",
        "canal": payload.canal,
        "data_empenho": payload.data_empenho.isoformat() if payload.data_empenho else None,
        "vigencia": payload.vigencia.isoformat() if payload.vigencia else None,
        "observacao": payload.observacao,
        "ativo": True,
    }
    if getattr(payload, "pregao_id", None):
        dados["pregao_id"] = str(payload.pregao_id)
    emp = db.table("empenhos").insert(dados).execute().data[0]

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
            "numero_pregao": e.get("numero_pregao"),
            "pregao_id": e.get("pregao_id"),
            "tipo": e.get("tipo") or "CONSIGNACAO",
            "cliente": (e.get("clientes") or {}).get("nome", "—"),
            "cliente_id": e.get("cliente_id"),
            "canal": e.get("canal"),
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
    remetido = _remessa_por_empenho(db, [empenho_id]).get(empenho_id, {})

    itens_out = []
    for it in itens:
        q = float(it.get("qtd_empenhada") or 0)
        vu = float(it.get("valor_unitario") or 0)
        pid = it.get("produto_id")
        cons = min(float(consumo.get(pid, 0.0)), q)
        rem = min(float(remetido.get(pid, 0.0)), q)
        itens_out.append({
            "produto_id": pid,
            "codigo": it.get("codigo"),
            "descricao": it.get("descricao"),
            "qtd_empenhada": round(q),
            "valor_unitario": vu,
            "qtd_faturada": round(cons),
            "qtd_saldo": round(q - cons),
            "valor_saldo": round((q - cons) * vu, 2),
            # Consignacao tem dois saldos, e sao coisas diferentes:
            #   a remeter        = contratado - ja remetido
            #   na mao do cliente = remetido - consumido por comunicado de uso
            # Na venda direta remessa nao existe: `qtd_remetida` fica 0 e
            # `qtd_a_remeter` acompanha o saldo.
            "qtd_remetida": round(rem),
            "qtd_a_remeter": round(q - rem),
            "qtd_com_cliente": round(max(rem - cons, 0)),
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
        "numero_pregao": e.get("numero_pregao"),
        "tipo": e.get("tipo") or "CONSIGNACAO",
        "cliente": (e.get("clientes") or {}).get("nome", "—"),
        "cliente_id": e.get("cliente_id"),
        "canal": e.get("canal"),
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

    # Valida saldo por item antes de faturar; herda o preço unitário do contrato
    detalhe = obter_empenho(empenho_id)
    saldo = {i["produto_id"]: i["qtd_saldo"] for i in detalhe["itens"]}
    preco = {i["produto_id"]: float(i.get("valor_unitario") or 0) for i in detalhe["itens"]}
    for it in payload.itens:
        pid = str(it.produto_id)
        if pid not in saldo:
            raise HTTPException(status_code=422, detail="Item não pertence a este empenho")
        if it.qtd_solicitada > saldo[pid] + 0.001:
            raise HTTPException(status_code=422, detail=f"Quantidade acima do saldo do item (saldo {saldo[pid]})")
        if it.valor_unitario is None and preco.get(pid):
            it.valor_unitario = preco[pid]

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
        af=getattr(payload, "af", None),
        nome_paciente=getattr(payload, "nome_paciente", None),
        prontuario=getattr(payload, "prontuario", None),
        data_procedimento=getattr(payload, "data_procedimento", None),
    )
    pedido_service.criar_comunicado_uso(comunicado, usuario)
    return obter_empenho(empenho_id)


def registrar_entrega(empenho_id: str, payload: EntregaVendaDiretaCreate, usuario: UsuarioOut) -> dict:
    """Saída de material de um contrato — gera uma OV no fluxo logístico.

    Vale para os dois tipos de contrato, porque a saída é a MESMA operação nos
    dois: separar, conferir, cotar frete, emitir nota. O que muda é o significado
    do que saiu:

      venda direta  → a entrega cumpre o contrato (OV VENDA_NORMAL, fatura)
      consignação   → a remessa só muda o material de lugar (OV CONSIGNADO, não
                      fatura); quem cumpre o contrato é o comunicado de uso,
                      depois, conforme o cliente usa

    Antes daqui saía um 400 dizendo "consignação usa comunicado de uso", o que
    confundia como FATURA com como SAI DA CASA. O efeito era o material de
    consignado sair sem passar pela expedição — sem reserva de estoque, sem
    conferência e sem registro de quanto material nosso está com o cliente."""
    from app.models.schemas import PedidoCreate
    from app.services import pedido_service

    db = get_service_db()
    emp = db.table("empenhos").select("id, cliente_id, tipo").eq("id", empenho_id).single().execute().data
    if not emp:
        raise HTTPException(status_code=404, detail="Contrato não encontrado")
    if not payload.itens:
        raise HTTPException(status_code=422, detail="Informe ao menos um item da entrega")

    tipo_contrato = emp.get("tipo") or "CONSIGNACAO"
    eh_consignacao = tipo_contrato == "CONSIGNACAO"

    # Valida saldo por item; herda o preço unitário do contrato para a OV.
    #
    # O teto é diferente em cada tipo, e tem que ser: na consignação o limite é o
    # que ainda não foi REMETIDO (o consumo vem depois, pelo comunicado de uso);
    # na venda direta é o saldo do contrato mesmo. Usar o saldo de consumo na
    # consignação deixaria remeter de novo o que já está com o cliente.
    detalhe = obter_empenho(empenho_id)
    campo_saldo = "qtd_a_remeter" if eh_consignacao else "qtd_saldo"
    saldo = {i["produto_id"]: i[campo_saldo] for i in detalhe["itens"]}
    preco = {i["produto_id"]: float(i.get("valor_unitario") or 0) for i in detalhe["itens"]}
    for it in payload.itens:
        pid = str(it.produto_id)
        if pid not in saldo:
            raise HTTPException(status_code=422, detail="Item não pertence a este contrato")
        if it.qtd_solicitada > saldo[pid] + 0.001:
            rotulo = "que ainda falta remeter" if eh_consignacao else "saldo"
            raise HTTPException(
                status_code=422,
                detail=f"Quantidade acima do {rotulo} neste item ({saldo[pid]}).")
        if it.valor_unitario is None and preco.get(pid):
            it.valor_unitario = preco[pid]

    ov = pedido_service.criar_pedido(
        PedidoCreate(
            numero_pedido=payload.numero_pedido,
            cliente_id=emp["cliente_id"],
            tipo_frete=payload.tipo_frete or "FOB",
            tipo_operacao="CONSIGNADO" if eh_consignacao else "VENDA_NORMAL",
            canal=payload.canal or detalhe.get("canal"),
            local_entrega=payload.local_entrega,
            data_prevista_entrega=payload.data_prevista_entrega,
            condicao_pagamento=payload.condicao_pagamento,
            itens=payload.itens,
            empenho_id=empenho_id,
        ),
        usuario,
    )
    detalhe = obter_empenho(empenho_id)
    detalhe["ov_gerada_id"] = ov.get("id")
    detalhe["ov_gerada_ref"] = ov.get("numero_pedido")

    # Espelha a entrega no painel de licitação: cria um card (em "OV gerada")
    # vinculado à OV, para o time acompanhar frete/NF por lá também — não só na
    # logística. O card segue o status real da OV (faturamento etc.).
    try:
        from datetime import datetime, timezone
        db.table("licitacao_demandas").insert({
            "tipo_operacao": tipo_contrato,
            "etapa": "OV_GERADA",
            "numero_pregao": detalhe.get("numero_pregao"),
            "numero": detalhe.get("numero"),
            "cliente_id": emp["cliente_id"],
            "canal": payload.canal or detalhe.get("canal"),
            "prazo": payload.data_prevista_entrega.isoformat() if payload.data_prevista_entrega else None,
            "gerado_tipo": "PEDIDO",
            "gerado_id": ov.get("id"),
            "gerado_ref": ov.get("numero_pedido"),
            "ref_externa": ov.get("numero_pedido"),
            "ovs": [{"id": ov.get("id"), "numero": ov.get("numero_pedido")}],
            "itens": [{"produto_id": str(it.produto_id), "codigo": None, "descricao": None,
                       "qtd": float(it.qtd_solicitada), "valor": float(it.valor_unitario or 0)}
                      for it in payload.itens],
            "observacao": f"Entrega do contrato {detalhe.get('numero')}",
            "ativo": True,
            "criado_em": datetime.now(timezone.utc).isoformat(),
            "atualizado_em": datetime.now(timezone.utc).isoformat(),
        }).execute()
    except Exception:
        pass

    return detalhe


def excluir_empenho(empenho_id: str) -> dict:
    db = get_service_db()
    vinculos = db.table("pedidos").select("id").eq("empenho_id", empenho_id).neq("status", "CANCELADO").execute().data
    if vinculos:
        raise HTTPException(status_code=400, detail="Este contrato já tem lançamentos (OV/comunicado) vinculados — não pode ser excluído")
    db.table("empenhos").update({"ativo": False}).eq("id", empenho_id).execute()
    return {"ok": True}
