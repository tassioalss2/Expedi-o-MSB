from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Query, UploadFile
from pydantic import BaseModel

from app.core.deps import get_current_user, lider_ou_superior
from app.models.schemas import (
    AgendarColetaRequest,
    AlterarStatusRequest,
    BloquearPedidoRequest,
    ConfirmarColetaRequest,
    FaturamentoRequest,
    FinalizarConferenciaRequest,
    FinalizarSeparacaoRequest,
    ImportacaoResultado,
    OcorrenciaCreate,
    OcorrenciaFechar,
    PedidoCreate,
    TratativaRequest,
    UsuarioOut,
)
from app.services import importacao_service, pedido_service

router = APIRouter(prefix="/pedidos", tags=["pedidos"])


# ── CRUD Pedidos ───────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def criar_pedido(payload: PedidoCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return pedido_service.criar_pedido(payload, usuario)


@router.get("")
def listar_pedidos(
    status: Optional[str] = Query(None),
    cliente_id: Optional[UUID] = Query(None),
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    prioridade: Optional[str] = Query(None),
    atrasados: Optional[bool] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.listar_pedidos(
        status_filter=status,
        cliente_id=str(cliente_id) if cliente_id else None,
        data_inicio=data_inicio,
        data_fim=data_fim,
        prioridade=prioridade,
        atrasados=atrasados,
    )


@router.get("/familia/{numero_pedido}")
def listar_familia(numero_pedido: str, _: UsuarioOut = Depends(get_current_user)):
    return pedido_service.listar_familia(numero_pedido)


@router.get("/{pedido_id}")
def obter_pedido(pedido_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return pedido_service.obter_pedido(str(pedido_id))


@router.patch("/{pedido_id}/status")
def alterar_status(
    pedido_id: UUID,
    payload: AlterarStatusRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.alterar_status(str(pedido_id), payload.novo_status.value, usuario, payload.observacao)


class RetornarEtapaRequest(BaseModel):
    status_destino: str
    motivo: str = ''
    registrar_ocorrencia: bool = True


@router.post("/{pedido_id}/retornar-etapa")
def retornar_etapa(
    pedido_id: UUID,
    payload: RetornarEtapaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    from app.core.database import get_service_db
    from app.services.inventario_service import _agora, _get_usuario_real
    from app.models.enums import StatusPedido

    db = get_service_db()
    uid = _get_usuario_real(str(usuario.id))

    pedido = db.table("pedidos").select("*").eq("id", str(pedido_id)).single().execute().data
    if not pedido:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    status_anterior = pedido["status"]
    agora = _agora()

    # Se estava no pallet, remove o vinculo (DELETE — tabela nao tem coluna status)
    if status_anterior == StatusPedido.AGUARD_COLETA.value:
        db.table("pallet_pedidos").delete().eq("pedido_id", str(pedido_id)).execute()

    # Atualiza status
    db.table("pedidos").update({
        "status": payload.status_destino,
        "atualizado_em": agora,
    }).eq("id", str(pedido_id)).execute()

    # Movimentação
    db.table("movimentacoes").insert({
        "pedido_id": str(pedido_id),
        "status_anterior": status_anterior,
        "status_novo": payload.status_destino,
        "usuario_id": uid,
        "observacao": f"↩ Retorno de etapa. Motivo: {payload.motivo}",
        "criado_em": agora,
    }).execute()

    # Ocorrência — só cria se solicitado
    if payload.registrar_ocorrencia:
        db.table("ocorrencias").insert({
            "pedido_id": str(pedido_id),
            "tipo": "Retornou a OV",
            "descricao": (
                f"OV {pedido['numero_pedido']} retornou de '{status_anterior}' para '{payload.status_destino}'.\n"
                f"Motivo: {payload.motivo}"
            ),
            "responsavel_id": uid,
            "status": "FECHADA",
            "resolucao": payload.motivo,
            "resolvido_por": uid,
            "resolvido_em": agora,
            "criado_em": agora,
        }).execute()

    return {"ok": True, "status_anterior": status_anterior, "status_novo": payload.status_destino}


class CancelarRequest(BaseModel):
    motivo: str


@router.post("/{pedido_id}/cancelar")
def cancelar_pedido(
    pedido_id: UUID,
    payload: CancelarRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    from app.core.database import get_service_db
    from app.services.inventario_service import _agora, _get_usuario_real
    from app.models.enums import StatusPedido

    db = get_service_db()
    uid = _get_usuario_real(str(usuario.id))

    pedido = db.table("pedidos").select("*").eq("id", str(pedido_id)).single().execute().data
    if not pedido:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    if pedido["status"] in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value):
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="Pedido já expedido ou cancelado não pode ser cancelado")

    status_anterior = pedido["status"]
    agora = _agora()

    # Cancela o pedido
    db.table("pedidos").update({
        "status": StatusPedido.CANCELADO.value,
        "atualizado_em": agora,
    }).eq("id", str(pedido_id)).execute()

    # Remove do pallet se estiver em algum
    db.table("pallet_pedidos").update({
        "status": "CANCELADO",
    }).eq("pedido_id", str(pedido_id)).eq("status", "AGUARDANDO").execute()

    # Registra movimentação
    db.table("movimentacoes").insert({
        "pedido_id": str(pedido_id),
        "status_anterior": status_anterior,
        "status_novo": StatusPedido.CANCELADO.value,
        "usuario_id": uid,
        "observacao": f"OV cancelada. Motivo: {payload.motivo}",
        "criado_em": agora,
    }).execute()

    # Registra ocorrência
    db.table("ocorrencias").insert({
        "pedido_id": str(pedido_id),
        "tipo": "Cancelamento de OV",
        "descricao": f"OV {pedido['numero_pedido']} cancelada.\nStatus no momento do cancelamento: {status_anterior}\nMotivo: {payload.motivo}",
        "responsavel_id": uid,
        "status": "FECHADA",
        "resolucao": payload.motivo,
        "resolvido_por": uid,
        "resolvido_em": agora,
        "criado_em": agora,
    }).execute()

    return {"ok": True, "numero_pedido": pedido["numero_pedido"], "motivo": payload.motivo}


@router.patch("/{pedido_id}/bloquear")
def bloquear_pedido(
    pedido_id: UUID,
    payload: BloquearPedidoRequest,
    usuario: UsuarioOut = Depends(lider_ou_superior),
):
    return pedido_service.alterar_status(str(pedido_id), "BLOQUEADO", usuario, payload.motivo)


# ── Separação ──────────────────────────────────────────────────────────────────

@router.post("/{pedido_id}/separacao/iniciar")
def iniciar_separacao(pedido_id: UUID, usuario: UsuarioOut = Depends(get_current_user)):
    return pedido_service.iniciar_separacao(str(pedido_id), usuario)


@router.post("/{pedido_id}/separacao/finalizar")
def finalizar_separacao(
    pedido_id: UUID,
    payload: FinalizarSeparacaoRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.finalizar_separacao(str(pedido_id), payload, usuario)


# ── Conferência ────────────────────────────────────────────────────────────────

@router.post("/{pedido_id}/conferencia/iniciar")
def iniciar_conferencia(pedido_id: UUID, usuario: UsuarioOut = Depends(get_current_user)):
    return pedido_service.iniciar_conferencia(str(pedido_id), usuario)


@router.post("/{pedido_id}/conferencia/finalizar")
def finalizar_conferencia(
    pedido_id: UUID,
    payload: FinalizarConferenciaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.finalizar_conferencia(str(pedido_id), payload, usuario)


# ── Tratativa ──────────────────────────────────────────────────────────────────

@router.post("/{pedido_id}/tratativa")
def registrar_tratativa(
    pedido_id: UUID,
    payload: TratativaRequest,
    usuario: UsuarioOut = Depends(lider_ou_superior),
):
    return pedido_service.registrar_tratativa(str(pedido_id), payload, usuario)


# ── Faturamento ────────────────────────────────────────────────────────────────

@router.post("/{pedido_id}/faturamento")
def registrar_faturamento(
    pedido_id: UUID,
    payload: FaturamentoRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.registrar_faturamento(str(pedido_id), payload, usuario)


# ── Coleta ─────────────────────────────────────────────────────────────────────

@router.post("/{pedido_id}/coleta/agendar")
def agendar_coleta(
    pedido_id: UUID,
    payload: AgendarColetaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.agendar_coleta(str(pedido_id), payload, usuario)


@router.post("/{pedido_id}/coleta/confirmar")
def confirmar_coleta(
    pedido_id: UUID,
    payload: ConfirmarColetaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.confirmar_coleta(str(pedido_id), payload, usuario)


# ── Ocorrências ────────────────────────────────────────────────────────────────

@router.post("/ocorrencias", status_code=201)
def criar_ocorrencia(payload: OcorrenciaCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return pedido_service.criar_ocorrencia(payload, usuario)


@router.patch("/ocorrencias/{ocorrencia_id}/fechar")
def fechar_ocorrencia(
    ocorrencia_id: UUID,
    payload: OcorrenciaFechar,
    usuario: UsuarioOut = Depends(lider_ou_superior),
):
    return pedido_service.fechar_ocorrencia(str(ocorrencia_id), payload.resolucao, usuario)


# ── Importação ─────────────────────────────────────────────────────────────────

@router.post("/importar", response_model=ImportacaoResultado)
async def importar_pedidos(
    arquivo: UploadFile = File(...),
    usuario: UsuarioOut = Depends(get_current_user),
):
    conteudo = await arquivo.read()
    return importacao_service.importar_arquivo(conteudo, arquivo.filename or "arquivo.csv", usuario)


# ── Dashboard / Indicadores ────────────────────────────────────────────────────

@router.get("/dashboard/financeiro")
def dashboard_financeiro(
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    """Faturamento NF e custo de frete das notas FATURADAS no período.

    Atribui cada NF ao mês em que foi de fato faturada (movimentação para
    o status FATURADO), e não pela última atualização do pedido — que muda
    a cada mudança de status (coleta, expedição, etc.).
    """
    from datetime import datetime, timedelta, timezone
    from app.core.database import get_service_db
    db = get_service_db()

    hoje = date.today()
    inicio = data_inicio or date(hoje.year, hoje.month, 1)
    fim = data_fim or hoje

    # Janela alargada em 1 dia para cobrir a conversão UTC->BRT nas bordas do mês.
    janela_ini = (inicio - timedelta(days=1)).isoformat()
    janela_fim = (fim + timedelta(days=1)).isoformat()

    movs = db.table("movimentacoes").select(
        "pedido_id, criado_em"
    ).eq("status_novo", "FATURADO")\
        .gte("criado_em", f"{janela_ini}T00:00:00")\
        .lte("criado_em", f"{janela_fim}T23:59:59").execute().data

    # pedido_id -> data de faturamento (BRT), mantendo o faturamento dentro do período
    faturados: dict[str, str] = {}
    for m in movs:
        ts_str = m.get("criado_em")
        pid = m.get("pedido_id")
        if not ts_str or not pid:
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            data_brt = (ts.astimezone(timezone.utc) - timedelta(hours=3)).date()
        except Exception:
            continue
        if inicio <= data_brt <= fim:
            faturados[pid] = data_brt.isoformat()

    def _resumo(lista: list) -> dict:
        return {
            "total_nf": round(sum(float(p["valor_nf"] or 0) for p in lista if p.get("valor_nf")), 2),
            "total_produtos": round(sum(float(p["valor_produtos"] or 0) for p in lista if p.get("valor_produtos")), 2),
            "total_frete": round(sum(float(p["valor_frete"] or 0) for p in lista if p.get("valor_frete")), 2),
            "qtd_nfs": sum(1 for p in lista if p.get("valor_nf")),
            "qtd_com_frete": sum(1 for p in lista if p.get("valor_frete")),
        }

    if not faturados:
        vazio = _resumo([])
        return {
            "periodo": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
            **vazio,
            "transfer_price": vazio,
            "outras_vendas": vazio,
        }

    ids = list(faturados.keys())
    pedidos = db.table("pedidos").select(
        "id, valor_nf, valor_produtos, valor_frete, tipo_frete, status, clientes(nome)"
    ).in_("id", ids).neq("status", "CANCELADO").execute().data

    # Transfer price = vendas para a Biomedical (empresa do grupo).
    # Identificada pelo nome do cliente. Ajuste este critério se o cadastro mudar.
    def _eh_biomedical(p: dict) -> bool:
        nome = ((p.get("clientes") or {}).get("nome") or "").upper()
        return "BIOMEDICAL" in nome

    transfer = [p for p in pedidos if _eh_biomedical(p)]
    outras = [p for p in pedidos if not _eh_biomedical(p)]

    total = _resumo(pedidos)
    return {
        "periodo": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
        **total,
        "transfer_price": _resumo(transfer),
        "outras_vendas": _resumo(outras),
    }


@router.get("/dashboard/tempo-separacao")
def tempo_separacao(_: UsuarioOut = Depends(get_current_user)):
    """
    Retorna dados para o indicador de tempo de separação.
    - OVs concluídas hoje (chegaram a AGUARD_FATURAMENTO): tempo real
    - OVs em andamento: tempo desde criação até agora
    """
    from app.core.database import get_service_db
    db = get_service_db()

    # OVs que chegaram a AGUARD_FATURAMENTO hoje
    hoje = date.today().isoformat()
    concluidas = db.table("movimentacoes").select("pedido_id, criado_em").eq(
        "status_novo", "AGUARD_FATURAMENTO"
    ).gte("criado_em", f"{hoje}T00:00:00").execute().data

    # Para cada uma, busca o criado_em do pedido
    resultado = []
    for mov in concluidas:
        pedido = db.table("pedidos").select("criado_em,numero_pedido,status").eq("id", mov["pedido_id"]).execute().data
        if pedido:
            resultado.append({
                "numero_pedido": pedido[0]["numero_pedido"],
                "status": pedido[0]["status"],
                "inicio": pedido[0]["criado_em"],
                "fim": mov["criado_em"],
                "concluido": True,
            })

    # OVs em andamento (entre LIBERADO e AGUARD_FATURAMENTO)
    # Busca pedidos em processo de separação (status antes do faturamento)
    STATUS_EM_PROCESSO = ["LIBERADO","EM_INVENTARIO","AGUARD_VERIFICACAO","DIVERGENCIA","AGUARD_TRATATIVA","EM_PROCESSO_SISTEMICO"]
    em_processo = []
    for s in STATUS_EM_PROCESSO:
        res = db.table("pedidos").select("id,numero_pedido,status,criado_em").eq("status", s).execute().data
        em_processo.extend(res)

    for p in em_processo:
        resultado.append({
            "numero_pedido": p["numero_pedido"],
            "status": p["status"],
            "inicio": p["criado_em"],
            "fim": None,  # ainda em andamento
            "concluido": False,
        })

    return resultado


@router.get("/dashboard/operacional")
def dashboard_operacional(_: UsuarioOut = Depends(get_current_user)):
    return pedido_service.obter_dashboard_operacional()


@router.get("/dashboard/indicadores")
def indicadores(
    data_inicio: date = Query(...),
    data_fim: date = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.obter_indicadores(data_inicio, data_fim)


@router.get("/dashboard/horario-criacao")
def horario_criacao(
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.obter_horario_criacao(data_inicio, data_fim)


@router.get("/dashboard/horario-criacao/detalhe")
def horario_criacao_detalhe(
    hora: int = Query(..., ge=0, le=23),
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.obter_horario_criacao_detalhe(hora, data_inicio, data_fim)


@router.get("/dashboard/esforco")
def esforco_time(
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.obter_esforco_time(data_inicio, data_fim)


@router.get("/dashboard/indicadores/detalhes")
def indicadores_detalhes(
    metrica: str = Query(...),
    data_inicio: date = Query(...),
    data_fim: date = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.obter_indicadores_detalhes(metrica, data_inicio, data_fim)
