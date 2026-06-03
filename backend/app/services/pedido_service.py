from datetime import date, datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status

from app.core.database import get_service_db
from app.models.enums import (
    DecisaoTratativa,
    Prioridade,
    ResultadoConferencia,
    StatusPedido,
    TRANSICOES_PERMITIDAS,
)
from app.models.schemas import (
    AgendarColetaRequest,
    ConfirmarColetaRequest,
    FaturamentoRequest,
    FinalizarConferenciaRequest,
    FinalizarSeparacaoRequest,
    OcorrenciaCreate,
    PedidoCreate,
    TratativaRequest,
    UsuarioOut,
)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validar_transicao(atual: str, novo: str) -> None:
    permitidos = TRANSICOES_PERMITIDAS.get(StatusPedido(atual), [])
    if StatusPedido(novo) not in permitidos:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Transição '{atual}' → '{novo}' não é permitida",
        )


def _registrar_movimentacao(pedido_id: str, status_anterior: str, status_novo: str,
                             usuario_id: str, observacao: Optional[str] = None) -> None:
    db = get_service_db()
    # Busca o primeiro usuário real do banco para usar como referência
    usuarios = db.table("usuarios").select("id").limit(1).execute()
    uid = usuarios.data[0]["id"] if usuarios.data else None
    db.table("movimentacoes").insert({
        "pedido_id": pedido_id,
        "status_anterior": status_anterior,
        "status_novo": status_novo,
        "usuario_id": uid,
        "observacao": observacao,
        "criado_em": _agora(),
    }).execute()


def criar_pedido(payload: PedidoCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Verifica duplicidade
    existe = db.table("pedidos").select("id").eq("numero_pedido", payload.numero_pedido).execute()
    if existe.data:
        raise HTTPException(status_code=400, detail=f"Pedido '{payload.numero_pedido}' já existe")

    pedido_data = {
        "numero_pedido": payload.numero_pedido,
        "cliente_id": str(payload.cliente_id),
        "transportadora_id": str(payload.transportadora_id) if payload.transportadora_id else None,
        "tipo_frete": payload.tipo_frete.value if payload.tipo_frete else "FOB",
        "local_entrega": payload.local_entrega,
        "status": StatusPedido.LIBERADO.value,
        "prioridade": payload.prioridade.value,
        "data_prevista_entrega": payload.data_prevista_entrega.isoformat(),
        "data_prevista_coleta": payload.data_prevista_coleta.isoformat() if payload.data_prevista_coleta else None,
        "observacoes": payload.observacoes,
        "criado_por": None,
        "criado_em": _agora(),
        "atualizado_em": _agora(),
    }

    resultado = db.table("pedidos").insert(pedido_data).execute()
    pedido = resultado.data[0]

    # Insere itens
    itens = [
        {
            "pedido_id": pedido["id"],
            "produto_id": str(item.produto_id),
            "lote_id": str(item.lote_id) if item.lote_id else None,
            "qtd_solicitada": item.qtd_solicitada,
            "status_item": "PENDENTE",
        }
        for item in payload.itens
    ]
    if itens:
        db.table("itens_pedido").insert(itens).execute()

    _registrar_movimentacao(pedido["id"], None, StatusPedido.LIBERADO.value, str(usuario.id), "Pedido criado")
    return pedido


def listar_pedidos(
    status_filter: Optional[str] = None,
    cliente_id: Optional[str] = None,
    data_inicio: Optional[date] = None,
    data_fim: Optional[date] = None,
    prioridade: Optional[str] = None,
    atrasados: Optional[bool] = None,
) -> list[dict]:
    db = get_service_db()
    query = db.table("pedidos").select(
        "*, clientes(id, nome), transportadoras(id, nome)"
    )

    if status_filter:
        query = query.eq("status", status_filter)
    if cliente_id:
        query = query.eq("cliente_id", cliente_id)
    if prioridade:
        query = query.eq("prioridade", prioridade)
    if data_inicio:
        query = query.gte("data_prevista_entrega", data_inicio.isoformat())
    if data_fim:
        query = query.lte("data_prevista_entrega", data_fim.isoformat())

    resultado = query.order("prioridade", desc=True).order("data_prevista_entrega").execute()
    pedidos = resultado.data

    hoje = date.today().isoformat()
    for p in pedidos:
        p["atrasado"] = (
            p["data_prevista_entrega"] < hoje
            and p["status"] not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)
        )
        p["cliente_nome"] = p.get("clientes", {}).get("nome", "") if p.get("clientes") else ""
        p["transportadora_nome"] = p.get("transportadoras", {}).get("nome") if p.get("transportadoras") else None

    if atrasados is not None:
        pedidos = [p for p in pedidos if p["atrasado"] == atrasados]

    # Críticos e atrasados primeiro
    pedidos.sort(key=lambda p: (
        0 if p["prioridade"] == Prioridade.CRITICA.value else (1 if p["prioridade"] == Prioridade.ALTA.value else 2),
        0 if p["atrasado"] else 1,
        p["data_prevista_entrega"],
    ))

    return pedidos


def obter_pedido(pedido_id: str) -> dict:
    db = get_service_db()
    resultado = db.table("pedidos").select(
        "*, clientes(*), transportadoras(*), itens_pedido(*, produtos(*), lotes(*))"
    ).eq("id", pedido_id).single().execute()

    if not resultado.data:
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    p = resultado.data
    hoje = date.today().isoformat()
    p["atrasado"] = (
        p["data_prevista_entrega"] < hoje
        and p["status"] not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)
    )
    # Mapeia nomes do join (plural → singular) para o frontend
    p["cliente"] = p.pop("clientes", None)
    p["transportadora"] = p.pop("transportadoras", None)
    p["itens"] = p.pop("itens_pedido", []) or []
    p["cliente_nome"] = p.get("cliente", {}).get("nome", "") if p.get("cliente") else ""
    p["transportadora_nome"] = p.get("transportadora", {}).get("nome", "") if p.get("transportadora") else ""
    return p


def alterar_status(pedido_id: str, novo_status: str, usuario: UsuarioOut,
                   observacao: Optional[str] = None) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    _validar_transicao(pedido["status"], novo_status)

    db.table("pedidos").update({
        "status": novo_status,
        "atualizado_em": _agora(),
    }).eq("id", pedido_id).execute()

    _registrar_movimentacao(pedido_id, pedido["status"], novo_status, str(usuario.id), observacao)
    return obter_pedido(pedido_id)


# ── Separação ──────────────────────────────────────────────────────────────────

def iniciar_separacao(pedido_id: str, usuario: UsuarioOut) -> dict:
    pedido = obter_pedido(pedido_id)
    if pedido["status"] not in (StatusPedido.LIBERADO.value, StatusPedido.SEPARADO.value):
        raise HTTPException(status_code=422, detail="Pedido não está disponível para separação")

    db = get_service_db()
    sep = db.table("separacoes").insert({
        "pedido_id": pedido_id,
        "operador_id": str(usuario.id),
        "inicio": _agora(),
    }).execute().data[0]

    alterar_status(pedido_id, StatusPedido.EM_SEPARACAO.value, usuario, "Separação iniciada")
    return sep


def finalizar_separacao(pedido_id: str, payload: FinalizarSeparacaoRequest,
                         usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Atualiza qtd separada nos itens
    for item in payload.itens:
        update = {"qtd_separada": item["qtd_separada"], "status_item": "SEPARADO"}
        if item.get("lote_id"):
            update["lote_id"] = item["lote_id"]
        db.table("itens_pedido").update(update).eq("id", item["item_id"]).execute()

    # Finaliza registro de separação
    sep = db.table("separacoes").select("id").eq("pedido_id", pedido_id).order("inicio", desc=True).limit(1).execute()
    if sep.data:
        db.table("separacoes").update({"fim": _agora(), "observacao": payload.observacao}).eq("id", sep.data[0]["id"]).execute()

    alterar_status(pedido_id, StatusPedido.SEPARADO.value, usuario, payload.observacao or "Separação concluída")
    return obter_pedido(pedido_id)


# ── Conferência ────────────────────────────────────────────────────────────────

def iniciar_conferencia(pedido_id: str, usuario: UsuarioOut) -> dict:
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.SEPARADO.value:
        raise HTTPException(status_code=422, detail="Pedido precisa estar SEPARADO para iniciar conferência")

    db = get_service_db()
    conf = db.table("conferencias").insert({
        "pedido_id": pedido_id,
        "conferente_id": str(usuario.id),
        "inicio": _agora(),
        "resultado": "PENDENTE",
    }).execute().data[0]

    alterar_status(pedido_id, StatusPedido.EM_CONFERENCIA.value, usuario, "Conferência iniciada")
    return conf


def finalizar_conferencia(pedido_id: str, payload: FinalizarConferenciaRequest,
                           usuario: UsuarioOut) -> dict:
    db = get_service_db()

    for item in payload.itens_conferidos:
        update = {
            "qtd_conferida": item["qtd_conferida"],
            "status_item": "CONFERIDO" if payload.resultado == ResultadoConferencia.OK else "DIVERGENCIA",
        }
        if item.get("qtd_divergente"):
            update["qtd_divergente"] = item["qtd_divergente"]
        db.table("itens_pedido").update(update).eq("id", item["item_id"]).execute()

    # Finaliza registro
    conf = db.table("conferencias").select("id").eq("pedido_id", pedido_id).order("inicio", desc=True).limit(1).execute()
    if conf.data:
        db.table("conferencias").update({
            "fim": _agora(),
            "resultado": payload.resultado.value,
            "observacao": payload.observacao,
        }).eq("id", conf.data[0]["id"]).execute()

    novo_status = (
        StatusPedido.CONFERIDO.value
        if payload.resultado == ResultadoConferencia.OK
        else StatusPedido.DIVERGENCIA.value
    )
    alterar_status(pedido_id, novo_status, usuario, payload.observacao)
    return obter_pedido(pedido_id)


# ── Tratativa ──────────────────────────────────────────────────────────────────

def registrar_tratativa(pedido_id: str, payload: TratativaRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    db.table("tratativas").insert({
        "pedido_id": pedido_id,
        "responsavel_id": str(usuario.id),
        "decisao": payload.decisao.value,
        "justificativa": payload.justificativa,
        "retrabalho": payload.retrabalho,
        "tempo_retrabalho_min": payload.tempo_retrabalho_min,
        "criado_em": _agora(),
    }).execute()

    if payload.decisao == DecisaoTratativa.CORRIGIR:
        proximo = StatusPedido.EM_SEPARACAO.value
    elif payload.decisao == DecisaoTratativa.EXPEDIR_PARCIAL:
        proximo = StatusPedido.CONFERIDO.value
    else:
        proximo = StatusPedido.BLOQUEADO.value

    alterar_status(pedido_id, proximo, usuario, f"Tratativa: {payload.justificativa}")
    return obter_pedido(pedido_id)


# ── Faturamento ────────────────────────────────────────────────────────────────

def registrar_faturamento(pedido_id: str, payload: FaturamentoRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.AGUARD_FATURAMENTO.value:
        raise HTTPException(status_code=422, detail="Pedido não está aguardando faturamento")

    db.table("pedidos").update({
        "numero_nf": payload.numero_nf,
        "valor_nf": payload.valor_nf,
        "valor_produtos": payload.valor_produtos,
        "valor_frete": payload.valor_frete,
        "chave_nfe": payload.chave_nfe,
        "atualizado_em": _agora(),
    }).eq("id", pedido_id).execute()

    alterar_status(pedido_id, StatusPedido.FATURADO.value, usuario, f"NF {payload.numero_nf} emitida")
    return obter_pedido(pedido_id)


# ── Coleta ─────────────────────────────────────────────────────────────────────

def agendar_coleta(pedido_id: str, payload: AgendarColetaRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.FATURADO.value:
        raise HTTPException(status_code=422, detail="Pedido precisa estar FATURADO para agendar coleta")

    db.table("pedidos").update({
        "transportadora_id": str(payload.transportadora_id),
        "data_prevista_coleta": payload.data_prevista_coleta.isoformat(),
        "atualizado_em": _agora(),
    }).eq("id", pedido_id).execute()

    alterar_status(pedido_id, StatusPedido.AGUARD_COLETA.value, usuario, "Coleta agendada")
    return obter_pedido(pedido_id)


def confirmar_coleta(pedido_id: str, payload: ConfirmarColetaRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.AGUARD_COLETA.value:
        raise HTTPException(status_code=422, detail="Pedido não está aguardando coleta")

    db.table("pedidos").update({
        "data_real_coleta": payload.data_real_coleta.isoformat(),
        "atualizado_em": _agora(),
    }).eq("id", pedido_id).execute()

    db.table("coletas").insert({
        "pedido_id": pedido_id,
        "motorista": payload.motorista,
        "placa": payload.placa,
        "protocolo": payload.protocolo,
        "data_real": payload.data_real_coleta.isoformat(),
        "registrado_por": str(usuario.id),
        "criado_em": _agora(),
    }).execute()

    alterar_status(pedido_id, StatusPedido.COLETADO.value, usuario, f"Coleta confirmada — {payload.protocolo or ''}")
    alterar_status(pedido_id, StatusPedido.EXPEDIDO.value, usuario, "Expedição finalizada")
    return obter_pedido(pedido_id)


# ── Ocorrências ────────────────────────────────────────────────────────────────

def criar_ocorrencia(payload: OcorrenciaCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Resolve pedido_id: aceita UUID ou número de OV (ex: OV015406)
    pedido_id = payload.pedido_id.strip()
    if pedido_id.upper().startswith("OV"):
        resultado = db.table("pedidos").select("id").eq("numero_pedido", pedido_id.upper()).execute()
        if not resultado.data:
            raise HTTPException(status_code=404, detail=f"Pedido '{pedido_id}' não encontrado")
        pedido_id = resultado.data[0]["id"]

    # Busca usuário real
    from app.services.inventario_service import _get_usuario_real
    uid = _get_usuario_real(str(usuario.id))

    result = db.table("ocorrencias").insert({
        "pedido_id": pedido_id,
        "tipo": payload.tipo,
        "descricao": payload.descricao,
        "responsavel_id": uid,
        "status": "ABERTA",
        "retrabalho": True,
        "criado_em": _agora(),
    }).execute()
    return result.data[0]


def fechar_ocorrencia(ocorrencia_id: str, resolucao: str, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    result = db.table("ocorrencias").update({
        "status": "FECHADA",
        "resolucao": resolucao,
        "resolvido_por": str(usuario.id),
        "resolvido_em": _agora(),
    }).eq("id", ocorrencia_id).execute()
    return result.data[0]


# ── Dashboard ──────────────────────────────────────────────────────────────────

def obter_dashboard_operacional() -> dict:
    db = get_service_db()
    hoje = date.today().isoformat()

    todos = db.table("pedidos").select("status, data_prevista_entrega").execute().data
    expedidos_hoje = db.table("pedidos").select("id").eq("status", StatusPedido.EXPEDIDO.value)\
        .gte("atualizado_em", f"{hoje}T00:00:00").execute().data
    ocorrencias = db.table("ocorrencias").select("id").eq("status", "ABERTA").execute().data

    por_status: dict[str, dict] = {}
    atrasados_total = 0
    for p in todos:
        s = p["status"]
        atrasado = (
            p["data_prevista_entrega"] < hoje
            and s not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)
        )
        if atrasado:
            atrasados_total += 1
        if s not in por_status:
            por_status[s] = {"status": s, "quantidade": 0, "atrasados": 0}
        por_status[s]["quantidade"] += 1
        if atrasado:
            por_status[s]["atrasados"] += 1

    return {
        "data": hoje,
        "total_pedidos": len([p for p in todos if p["status"] not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)]),
        "expedidos_hoje": len(expedidos_hoje),
        "atrasados": atrasados_total,
        "por_status": list(por_status.values()),
        "ocorrencias_abertas": len(ocorrencias),
    }


def obter_indicadores(data_inicio: date, data_fim: date) -> dict:
    db = get_service_db()

    expedidos = db.table("pedidos").select("*")\
        .eq("status", StatusPedido.EXPEDIDO.value)\
        .gte("atualizado_em", f"{data_inicio.isoformat()}T00:00:00")\
        .lte("atualizado_em", f"{data_fim.isoformat()}T23:59:59")\
        .execute().data

    no_prazo = sum(
        1 for p in expedidos
        if p.get("data_real_coleta") and p["data_real_coleta"][:10] <= p["data_prevista_entrega"]
    )
    otif = (no_prazo / len(expedidos) * 100) if expedidos else 0

    # Taxa de divergência via ocorrências
    ocorrencias_div = db.table("ocorrencias").select("id")\
        .eq("tipo", "Divergência de Estoque")\
        .gte("criado_em", f"{data_inicio.isoformat()}T00:00:00")\
        .execute().data
    taxa_div = (len(ocorrencias_div) / max(len(expedidos), 1)) * 100

    # Taxa de retrabalho — todas as ocorrências são retrabalho
    ocorrencias_ret = db.table("ocorrencias").select("id")\
        .eq("retrabalho", True)\
        .gte("criado_em", f"{data_inicio.isoformat()}T00:00:00")\
        .execute().data
    taxa_retrab = (len(ocorrencias_ret) / max(len(expedidos), 1)) * 100

    backlog = db.table("pedidos").select("id")\
        .not_.in_("status", [StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value])\
        .execute().data

    return {
        "otif": round(otif, 2),
        "taxa_divergencia": round(taxa_div, 2),
        "taxa_retrabalho": round(taxa_retrab, 2),
        "lead_time_medio_horas": 0,  # calcular via separacoes + conferencias
        "pedidos_expedidos": len(expedidos),
        "backlog": len(backlog),
        "aderencia_cutoff": None,
    }
