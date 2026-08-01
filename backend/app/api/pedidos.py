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
    ComunicadoUsoCreate,
    ConfirmarColetaRequest,
    CotacaoFreteRequest,
    EditarItensRequest,
    FaturamentoRequest,
    MetaFaturamentoRequest,
    TransportadoraClienteRequest,
    FinalizarConferenciaRequest,
    FinalizarSeparacaoRequest,
    GerarOVRequest,
    ImportacaoResultado,
    OcorrenciaCreate,
    OcorrenciaFechar,
    PedidoCreate,
    PedidoOutboundCreate,
    ReclassificarCanalRequest,
    TratativaRequest,
    UsuarioOut,
)
from app.services import importacao_service, pedido_service

router = APIRouter(prefix="/pedidos", tags=["pedidos"])


# ── CRUD Pedidos ───────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def criar_pedido(payload: PedidoCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return pedido_service.criar_pedido(payload, usuario)


@router.post("/outbound", status_code=201)
def criar_pedido_outbound(payload: PedidoOutboundCreate, usuario: UsuarioOut = Depends(get_current_user)):
    """Venda outbound fechada direto pelo comercial (sem passar pelo CRM).
    Cai no kanban em AGUARD_DADOS_OV — operações completa o número da OV depois."""
    return pedido_service.criar_pedido_outbound(payload, usuario)


@router.post("/comunicado-uso", status_code=201)
def criar_comunicado_uso(payload: ComunicadoUsoCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return pedido_service.criar_comunicado_uso(payload, usuario)


@router.post("/resumo-diario")
def enviar_resumo_diario(_: UsuarioOut = Depends(get_current_user)):
    """Envia o resumo do dia ao canal Teams (o mesmo do envio automático das 08h)."""
    from app.services import resumo_service
    return resumo_service.enviar_resumo(forcar=True)


@router.get("/meta")
def obter_meta(competencia: str = Query(...), _: UsuarioOut = Depends(get_current_user)):
    """Meta de faturamento do mês (competencia = 'YYYY-MM')."""
    return pedido_service.obter_meta(competencia)


@router.put("/meta")
def definir_meta(payload: MetaFaturamentoRequest, _: UsuarioOut = Depends(get_current_user)):
    return pedido_service.definir_meta(payload.competencia, payload.canal, payload.valor)


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


@router.get("/{pedido_id}/movimentacoes")
def listar_movimentacoes(pedido_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    from app.core.database import get_service_db
    db = get_service_db()
    rows = db.table("movimentacoes").select(
        "status_anterior, status_novo, observacao, criado_em"
    ).eq("pedido_id", str(pedido_id)).order("criado_em").execute().data
    return rows


@router.patch("/{pedido_id}/completar-dados-crm")
def completar_dados_ov(pedido_id: UUID, payload: GerarOVRequest,
                       usuario: UsuarioOut = Depends(get_current_user)):
    """Completa uma OV-esqueleto criada pelo ganho de uma oportunidade no CRM:
    número real (D365), data prevista e frete. Sai de AGUARD_DADOS_OV direto
    para LIBERADO."""
    return pedido_service.completar_dados_ov(
        str(pedido_id), payload.numero_pedido, payload.data_prevista_entrega,
        payload.tipo_frete, payload.local_entrega, usuario)


@router.patch("/{pedido_id}/canal-licitacao")
def reclassificar_canal_licitacao(pedido_id: UUID, payload: ReclassificarCanalRequest,
                                  usuario: UsuarioOut = Depends(get_current_user)):
    """Reclassifica uma OV de licitação legado para Uro/Vascular (drill-down do Painel Comercial)."""
    return pedido_service.reclassificar_canal_licitacao(str(pedido_id), payload.canal.value, usuario)


@router.patch("/{pedido_id}/itens")
def editar_itens(pedido_id: UUID, payload: EditarItensRequest,
                 usuario: UsuarioOut = Depends(get_current_user)):
    """Substitui os itens da OV — ex.: item sem estoque trocado por outro.
    Bloqueado depois de FATURADO (o item vira o que está na NF)."""
    return pedido_service.editar_itens(str(pedido_id), payload.itens, usuario)


@router.patch("/{pedido_id}/status")
def alterar_status(
    pedido_id: UUID,
    payload: AlterarStatusRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.alterar_status(str(pedido_id), payload.novo_status.value, usuario, payload.observacao)


class ReativarRequest(BaseModel):
    motivo: str
    dados: Optional[dict] = None


@router.post("/{pedido_id}/reativar")
def reativar_pedido(
    pedido_id: UUID,
    payload: ReativarRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.reativar_pedido(str(pedido_id), payload.motivo, usuario, payload.dados)


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

@router.post("/{pedido_id}/cotacao-frete")
def registrar_cotacao_frete(
    pedido_id: UUID,
    payload: CotacaoFreteRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.registrar_cotacao_frete(str(pedido_id), payload, usuario)


@router.post("/{pedido_id}/transportadora-cliente")
def registrar_transportadora_cliente(
    pedido_id: UUID,
    payload: TransportadoraClienteRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.registrar_transportadora_cliente(str(pedido_id), payload, usuario)


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

def _eh_biomedical(pedido: dict) -> bool:
    """Transfer price = vendas para a Biomedical (empresa do grupo).
    Identificada pelo nome do cliente. Ajuste aqui se o cadastro mudar."""
    nome = ((pedido.get("clientes") or {}).get("nome") or "").upper()
    return "BIOMEDICAL" in nome


# Só estas naturezas entram no faturamento; as demais (bonificação, amostra,
# consignado) geram NF e passam pelo fluxo, mas não são faturamento.
_OPERACOES_FATURAMENTO = {"VENDA_NORMAL", "COMUNICADO_USO"}


def _conta_faturamento(pedido: dict) -> bool:
    # Legado sem tipo_operacao definido é tratado como venda normal.
    return (pedido.get("tipo_operacao") or "VENDA_NORMAL") in _OPERACOES_FATURAMENTO


def _canal_base(canal: Optional[str]) -> str:
    """Canal onde o faturamento é contabilizado. Licitação sempre cai no
    canal base (Uro ou Vascular); LICITACAO puro é legado sem base definida."""
    if canal == "LICITACAO_URO":
        return "URO"
    if canal == "LICITACAO_VASCULAR":
        return "VASCULAR"
    return canal or "SEM_CANAL"


def _eh_licitacao(canal: Optional[str]) -> bool:
    return canal in ("LICITACAO_URO", "LICITACAO_VASCULAR", "LICITACAO")


def _faturados_no_periodo(inicio: date, fim: date) -> dict:
    """pedido_id -> data de faturamento (BRT, ISO) das NFs faturadas no período.

    Atribui cada NF ao dia em que foi de fato faturada (movimentação para o
    status FATURADO), e não pela última atualização do pedido — que muda a
    cada mudança de status (coleta, expedição, etc.).
    """
    from datetime import datetime, timedelta, timezone
    from app.core.database import get_service_db
    db = get_service_db()

    # Janela alargada em 1 dia para cobrir a conversão UTC->BRT nas bordas do mês.
    janela_ini = (inicio - timedelta(days=1)).isoformat()
    janela_fim = (fim + timedelta(days=1)).isoformat()

    movs = db.table("movimentacoes").select(
        "pedido_id, criado_em"
    ).eq("status_novo", "FATURADO")\
        .gte("criado_em", f"{janela_ini}T00:00:00")\
        .lte("criado_em", f"{janela_fim}T23:59:59").execute().data

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
    return faturados


@router.get("/dashboard/financeiro")
def dashboard_financeiro(
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    """Faturamento NF e custo de frete das notas FATURADAS no período."""
    from app.core.database import get_service_db
    db = get_service_db()

    hoje = date.today()
    inicio = data_inicio or date(hoje.year, hoje.month, 1)
    fim = data_fim or hoje

    faturados = _faturados_no_periodo(inicio, fim)

    def _resumo(lista: list) -> dict:
        # Natureza do frete (DRE):
        # - CIF_COM_VALOR: frete embutido na NF, ressarcido pelo cliente -> neutro no resultado
        # - CIF_SEM_VALOR: frete NÃO vai na NF; foi digitado dentro do valor_nf por
        #   hábito, mas não é faturamento -> removido do bruto e do sem-frete.
        total_nf_bruto = sum(float(p["valor_nf"] or 0) for p in lista if p.get("valor_nf"))
        total_produtos = sum(float(p["valor_produtos"] or 0) for p in lista if p.get("valor_produtos"))
        total_frete = sum(float(p["valor_frete"] or 0) for p in lista if p.get("valor_frete"))
        frete_ressarcido = sum(float(p["valor_frete"] or 0) for p in lista
                               if p.get("valor_frete") and p.get("tipo_frete") == "CIF_COM_VALOR")
        frete_proprio = sum(float(p["valor_frete"] or 0) for p in lista
                            if p.get("valor_frete") and p.get("tipo_frete") == "CIF_SEM_VALOR")
        # Faturamento = NF fiscal. Tira o frete CIF sem valor, que não está na NF.
        total_nf = total_nf_bruto - frete_proprio
        return {
            "total_nf": round(total_nf, 2),
            "total_produtos": round(total_produtos, 2),
            "total_frete": round(total_frete, 2),
            # Sem frete: também tira o CIF com valor (esse sim está na NF, mas é frete).
            "faturamento_sem_frete": round(total_nf - frete_ressarcido, 2),
            "frete_ressarcido": round(frete_ressarcido, 2),
            "frete_proprio": round(frete_proprio, 2),
            "qtd_nfs": sum(1 for p in lista if p.get("valor_nf")),
            "qtd_com_frete": sum(1 for p in lista if p.get("valor_frete")),
        }

    def _sem_faturamento(lista: list) -> list:
        # Agrega as operações que NÃO entram no faturamento por natureza.
        LABELS = {
            "BONIFICACAO_DOACAO": "Bonificação/Doação",
            "AMOSTRA": "Amostra",
            "CONSIGNADO": "Consignado",
        }
        agg: dict = {}
        for p in lista:
            op = p.get("tipo_operacao") or ""
            if op in _OPERACOES_FATURAMENTO:
                continue
            g = agg.setdefault(op, {"tipo": op, "label": LABELS.get(op, op or "—"), "qtd": 0, "valor_nf": 0.0})
            g["qtd"] += 1
            g["valor_nf"] += float(p.get("valor_nf") or 0)
        for g in agg.values():
            g["valor_nf"] = round(g["valor_nf"], 2)
        return sorted(agg.values(), key=lambda x: -x["valor_nf"])

    if not faturados:
        vazio = _resumo([])
        return {
            "periodo": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
            **vazio,
            "transfer_price": vazio,
            "outras_vendas": vazio,
            "sem_faturamento": [],
        }

    ids = list(faturados.keys())
    pedidos = db.table("pedidos").select(
        "id, valor_nf, valor_produtos, valor_frete, tipo_frete, tipo_operacao, status, clientes(nome)"
    ).in_("id", ids).neq("status", "CANCELADO").execute().data

    # Só entram no faturamento venda normal e comunicado de uso.
    faturaveis = [p for p in pedidos if _conta_faturamento(p)]
    transfer = [p for p in faturaveis if _eh_biomedical(p)]
    outras = [p for p in faturaveis if not _eh_biomedical(p)]

    total = _resumo(faturaveis)
    return {
        "periodo": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
        **total,
        "transfer_price": _resumo(transfer),
        "outras_vendas": _resumo(outras),
        "sem_faturamento": _sem_faturamento(pedidos),
    }


@router.get("/dashboard/financeiro/detalhe")
def dashboard_financeiro_detalhe(
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    """Lista as NFs faturadas no período que geram os números do card financeiro.

    Retorna uma linha por pedido faturado, com os campos necessários para o
    front filtrar por grupo (transfer price / outras) e por natureza de frete.
    """
    from app.core.database import get_service_db
    db = get_service_db()

    hoje = date.today()
    inicio = data_inicio or date(hoje.year, hoje.month, 1)
    fim = data_fim or hoje

    faturados = _faturados_no_periodo(inicio, fim)
    if not faturados:
        return []

    ids = list(faturados.keys())
    pedidos = db.table("pedidos").select(
        "id, numero_pedido, numero_nf, valor_nf, valor_produtos, valor_frete, "
        "tipo_frete, tipo_operacao, canal, status, clientes(nome)"
    ).in_("id", ids).neq("status", "CANCELADO").execute().data

    linhas = []
    for p in pedidos:
        valor_nf = float(p.get("valor_nf") or 0)
        valor_frete = float(p.get("valor_frete") or 0)
        tipo_frete = p.get("tipo_frete")
        # CIF sem valor: frete não está na NF (foi digitado no valor_nf) -> tira do bruto.
        frete_fora_nf = valor_frete if tipo_frete == "CIF_SEM_VALOR" else 0.0
        # CIF com valor: frete está na NF, mas é frete -> tira só do "sem frete".
        frete_na_nf = valor_frete if tipo_frete == "CIF_COM_VALOR" else 0.0
        bruto = valor_nf - frete_fora_nf
        linhas.append({
            "id": p["id"],
            "numero_pedido": p.get("numero_pedido"),
            "numero_nf": p.get("numero_nf"),
            "cliente": (p.get("clientes") or {}).get("nome", "—"),
            "tipo_frete": tipo_frete,
            "tipo_operacao": p.get("tipo_operacao") or "VENDA_NORMAL",
            "canal": p.get("canal"),
            "eh_faturamento": _conta_faturamento(p),
            "valor_nf": round(bruto, 2),
            "valor_frete": round(valor_frete, 2),
            "valor_sem_frete": round(bruto - frete_na_nf, 2),
            "eh_biomedical": _eh_biomedical(p),
            "data": faturados.get(p["id"]),
        })

    return sorted(linhas, key=lambda x: (x["data"] or "", x["numero_pedido"] or ""))


@router.get("/dashboard/vendas-por-cliente")
def vendas_por_cliente(
    data_inicio: date = Query(...),
    data_fim: date = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    """Vendas (sem frete) agrupadas por cliente no período.

    Escopo = Vendas: só operações de faturamento (venda normal + comunicado
    de uso), excluindo Transfer Price (Biomedical) e Esterilize.
    """
    from app.core.database import get_service_db
    db = get_service_db()

    faturados = _faturados_no_periodo(data_inicio, data_fim)
    if not faturados:
        return []

    ids = list(faturados.keys())
    peds: list = []
    for i in range(0, len(ids), 40):
        peds += db.table("pedidos").select(
            "valor_nf, valor_frete, tipo_frete, tipo_operacao, status, clientes(nome)"
        ).in_("id", ids[i:i + 40]).neq("status", "CANCELADO").execute().data

    agg: dict = {}
    for p in peds:
        nome = ((p.get("clientes") or {}).get("nome") or "").strip()
        if not nome or "ESTERILIZE" in nome.upper() or _eh_biomedical(p):
            continue
        if not _conta_faturamento(p):
            continue
        valor = float(p.get("valor_nf") or 0)
        if p.get("tipo_frete") in ("CIF_SEM_VALOR", "CIF_COM_VALOR"):
            valor -= float(p.get("valor_frete") or 0)  # sem frete = só produtos
        g = agg.setdefault(nome, {"cliente": nome, "qtd": 0, "valor": 0.0})
        g["qtd"] += 1
        g["valor"] += valor

    for g in agg.values():
        g["valor"] = round(g["valor"], 2)
    return sorted(agg.values(), key=lambda x: -x["valor"])


@router.get("/dashboard/vendas-por-canal")
def vendas_por_canal(
    data_inicio: date = Query(...),
    data_fim: date = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    """Vendas (sem frete) agrupadas por canal comercial no período.

    Mesmo escopo de "Vendas": faturamento, sem Transfer Price nem Esterilize.
    A licitação é dobrada no canal base (Uro/Vascular) e também somada num
    total informativo à parte (quanto vendemos por licitação no mês).
    """
    from app.core.database import get_service_db
    db = get_service_db()

    faturados = _faturados_no_periodo(data_inicio, data_fim)
    if not faturados:
        return {"canais": [], "licitacao": {"qtd": 0, "valor": 0.0}}

    LABELS = {"URO": "Uro", "VASCULAR": "Vascular", "REALCLOSURE": "Realclosure", "LICITACAO": "Licitação"}
    ids = list(faturados.keys())
    peds: list = []
    for i in range(0, len(ids), 40):
        peds += db.table("pedidos").select(
            "valor_nf, valor_frete, tipo_frete, tipo_operacao, canal, status, clientes(nome)"
        ).in_("id", ids[i:i + 40]).neq("status", "CANCELADO").execute().data

    agg: dict = {}
    licit = {"qtd": 0, "valor": 0.0}
    for p in peds:
        nome = ((p.get("clientes") or {}).get("nome") or "").upper()
        if "ESTERILIZE" in nome or _eh_biomedical(p) or not _conta_faturamento(p):
            continue
        canal = _canal_base(p.get("canal"))
        valor = float(p.get("valor_nf") or 0)
        if p.get("tipo_frete") in ("CIF_SEM_VALOR", "CIF_COM_VALOR"):
            valor -= float(p.get("valor_frete") or 0)
        g = agg.setdefault(canal, {"canal": canal, "label": LABELS.get(canal, "Sem canal"), "qtd": 0, "valor": 0.0})
        g["qtd"] += 1
        g["valor"] += valor
        if _eh_licitacao(p.get("canal")):
            licit["qtd"] += 1
            licit["valor"] += valor

    for g in agg.values():
        g["valor"] = round(g["valor"], 2)
    licit["valor"] = round(licit["valor"], 2)
    return {
        "canais": sorted(agg.values(), key=lambda x: -x["valor"]),
        "licitacao": licit,
    }


@router.get("/dashboard/faturamento-diario")
def faturamento_diario(
    data_inicio: date = Query(...),
    data_fim: date = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    """Vendas (sem frete) por dia de faturamento no período.

    Mesmo escopo de "Vendas": faturamento, sem Transfer Price nem Esterilize.
    Retorna a série completa de dias (com zeros) para desenhar o gráfico do mês
    e o total do período.
    """
    from datetime import timedelta
    from app.core.database import get_service_db
    db = get_service_db()

    faturados = _faturados_no_periodo(data_inicio, data_fim)

    # Série completa de dias do período (dias sem venda ficam zerados no gráfico).
    dias: dict[str, dict] = {}
    d = data_inicio
    while d <= data_fim:
        iso = d.isoformat()
        dias[iso] = {"dia": iso, "valor": 0.0, "qtd": 0}
        d += timedelta(days=1)

    if faturados:
        ids = list(faturados.keys())
        peds: list = []
        for i in range(0, len(ids), 40):
            peds += db.table("pedidos").select(
                "id, valor_nf, valor_frete, tipo_frete, tipo_operacao, status, clientes(nome)"
            ).in_("id", ids[i:i + 40]).neq("status", "CANCELADO").execute().data
        for p in peds:
            nome = ((p.get("clientes") or {}).get("nome") or "").upper()
            if "ESTERILIZE" in nome or _eh_biomedical(p) or not _conta_faturamento(p):
                continue
            dia = faturados.get(p["id"])
            if dia not in dias:
                continue
            valor = float(p.get("valor_nf") or 0)
            if p.get("tipo_frete") in ("CIF_SEM_VALOR", "CIF_COM_VALOR"):
                valor -= float(p.get("valor_frete") or 0)
            dias[dia]["valor"] += valor
            dias[dia]["qtd"] += 1

    serie = sorted(dias.values(), key=lambda x: x["dia"])
    for g in serie:
        g["valor"] = round(g["valor"], 2)
    total = round(sum(g["valor"] for g in serie), 2)
    return {"dias": serie, "total": total}


@router.get("/dashboard/vendas-por-produto")
def vendas_por_produto(
    data_inicio: date = Query(...),
    data_fim: date = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    """Quantidade vendida por produto, a partir da coluna "Venda" do inventário
    contínuo (inventario_contagens.qtd_venda), agrupada por código de produto.

    Atenção: o período é pela DATA DA CONTAGEM (contado_em), não pela data de
    faturamento da NF — é uma medida de unidades vendidas, não de R$.
    """
    from app.core.database import get_service_db
    db = get_service_db()

    ini = f"{data_inicio.isoformat()}T00:00:00"
    fim = f"{data_fim.isoformat()}T23:59:59"
    contagens = db.table("inventario_contagens").select(
        "codigo_produto, descricao_produto, qtd_venda, contado_em"
    ).gte("contado_em", ini).lte("contado_em", fim).execute().data

    # Descrição pelo cadastro de produtos (a contagem nem sempre traz).
    produtos = db.table("produtos").select("codigo, descricao").execute().data
    desc_por_codigo = {p["codigo"]: p.get("descricao") for p in produtos if p.get("codigo")}

    agg: dict = {}
    for c in contagens:
        qtd = float(c.get("qtd_venda") or 0)
        if qtd <= 0:
            continue
        cod = (c.get("codigo_produto") or "").strip()
        if not cod:
            continue
        g = agg.setdefault(cod, {
            "codigo": cod,
            "descricao": c.get("descricao_produto") or desc_por_codigo.get(cod) or None,
            "qtd": 0.0,
            "contagens": 0,
        })
        g["qtd"] += qtd
        g["contagens"] += 1
        if not g["descricao"]:
            g["descricao"] = c.get("descricao_produto") or desc_por_codigo.get(cod)

    for g in agg.values():
        g["qtd"] = round(g["qtd"], 2)
    return sorted(agg.values(), key=lambda x: -x["qtd"])


@router.get("/relatorio/faturamento")
def relatorio_faturamento(
    data_inicio: date = Query(...),
    data_fim: date = Query(...),
    status: Optional[str] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    """Histórico de OVs pela DATA DE FATURAMENTO (movimentação -> FATURADO, BRT).

    O que importa é o dia do faturamento — não a última atualização do registro.
    """
    from app.core.database import get_service_db
    db = get_service_db()

    faturados = _faturados_no_periodo(data_inicio, data_fim)
    if not faturados:
        return []

    ids = list(faturados.keys())
    peds: list = []
    for i in range(0, len(ids), 40):
        peds += db.table("pedidos").select(
            "id, numero_pedido, numero_nf, valor_nf, valor_frete, tipo_frete, status, "
            "data_prevista_entrega, clientes(nome), transportadoras(nome)"
        ).in_("id", ids[i:i + 40]).execute().data

    linhas = []
    for p in peds:
        st = p.get("status")
        # Com status escolhido, filtra por ele; em "Todos", exclui cancelado.
        if status:
            if st != status:
                continue
        elif st == "CANCELADO":
            continue
        # CIF sem valor: o frete não está na NF — mostra o valor fiscal (sem esse frete).
        valor_nf = float(p.get("valor_nf") or 0)
        if p.get("tipo_frete") == "CIF_SEM_VALOR":
            valor_nf -= float(p.get("valor_frete") or 0)
        linhas.append({
            "id": p["id"],
            "numero_pedido": p.get("numero_pedido"),
            "numero_nf": p.get("numero_nf"),
            "cliente_nome": (p.get("clientes") or {}).get("nome"),
            "transportadora_nome": (p.get("transportadoras") or {}).get("nome"),
            "status": st,
            "tipo_frete": p.get("tipo_frete"),
            "valor_nf": round(valor_nf, 2),
            "data_prevista_entrega": p.get("data_prevista_entrega"),
            "data_faturamento": faturados.get(p["id"]),
        })

    return sorted(linhas, key=lambda x: x["data_faturamento"] or "", reverse=True)


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


@router.get("/faturamento/referencia")
def faturamento_referencia(
    cliente_id: UUID = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    """Histórico de NF do cliente — usado para alertar valores fora do padrão."""
    return pedido_service.obter_referencia_nf_cliente(str(cliente_id))


@router.get("/dashboard/esforco")
def esforco_time(
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.obter_esforco_time(data_inicio, data_fim)


@router.get("/dashboard/gargalo-etapas")
def gargalo_etapas(
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.obter_gargalo_etapas(data_inicio, data_fim)


@router.post("/alertas/varredura")
def alertas_varredura(
    horas_parada: int = Query(24, ge=1),
    enviar: bool = Query(True),
    _: UsuarioOut = Depends(get_current_user),
):
    """Varre OVs paradas há +N horas e (opcional) envia resumo ao Teams."""
    return pedido_service.varredura_alertas(horas_parada, enviar)


@router.get("/dashboard/indicadores/detalhes")
def indicadores_detalhes(
    metrica: str = Query(...),
    data_inicio: date = Query(...),
    data_fim: date = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    return pedido_service.obter_indicadores_detalhes(metrica, data_inicio, data_fim)
