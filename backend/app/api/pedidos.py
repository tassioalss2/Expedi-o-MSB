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
    DevolucaoCreate,
    DevolverAoCrmRequest,
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
    DevolverReservaRequest,
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


@router.post("/devolucao", status_code=201)
def criar_devolucao(payload: DevolucaoCreate, usuario: UsuarioOut = Depends(get_current_user)):
    """Registra a devolução de uma venda — não soma no faturamento bruto,
    subtrai do líquido (mesma lógica do "Valor correto" do D365)."""
    return pedido_service.criar_devolucao(payload, usuario)


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


# Ate 24/08/2026 a autoria da movimentacao nao valia: o codigo gravava sempre o
# primeiro usuario da tabela, nao quem agiu — 91% do historico de uma semana saiu
# no nome de uma pessoa do comercial que nao tinha feito inventario nenhum.
# Mostrar aquele nome seria afirmar uma coisa falsa sobre alguem, entao o historico
# ate ali aparece sem autor.
#
# O corte e 25/08 e nao 24/08 de proposito: a correcao subiu no dia 24, e as
# movimentacoes gravadas ANTES do deploy daquele mesmo dia ainda saíram erradas.
# Perder um dia de autoria correta e melhor do que exibir um dia de autoria falsa.
_AUTORIA_CONFIAVEL_A_PARTIR_DE = "2026-08-25"


@router.get("/{pedido_id}/movimentacoes")
def listar_movimentacoes(pedido_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    """Histórico da OV, com quem fez cada passo."""
    from app.core.database import get_service_db
    db = get_service_db()
    rows = db.table("movimentacoes").select(
        "status_anterior, status_novo, observacao, criado_em, usuarios(nome)"
    ).eq("pedido_id", str(pedido_id)).order("criado_em").execute().data

    for r in rows:
        nome = (r.pop("usuarios", None) or {}).get("nome")
        confiavel = str(r.get("criado_em") or "")[:10] >= _AUTORIA_CONFIAVEL_A_PARTIR_DE
        r["usuario"] = nome if (nome and confiavel) else None
    return rows


@router.patch("/{pedido_id}/completar-dados-crm")
def completar_dados_ov(pedido_id: UUID, payload: GerarOVRequest,
                       usuario: UsuarioOut = Depends(get_current_user)):
    """Completa uma OV-esqueleto criada pelo ganho de uma oportunidade no CRM:
    número real (D365), data prevista e frete. Sai de AGUARD_DADOS_OV direto
    para LIBERADO."""
    return pedido_service.completar_dados_ov(
        str(pedido_id), payload.numero_pedido, payload.data_prevista_entrega,
        payload.tipo_frete, payload.local_entrega, usuario,
        payload.condicao_pagamento)


@router.patch("/{pedido_id}/canal-licitacao")
def reclassificar_canal_licitacao(pedido_id: UUID, payload: ReclassificarCanalRequest,
                                  usuario: UsuarioOut = Depends(get_current_user)):
    """Reclassifica uma OV de licitação legado para Uro/Vascular (drill-down do Painel Comercial)."""
    return pedido_service.reclassificar_canal_licitacao(str(pedido_id), payload.canal.value, usuario)


@router.patch("/{pedido_id}/itens")
def editar_itens(pedido_id: UUID, payload: EditarItensRequest,
                 usuario: UsuarioOut = Depends(get_current_user)):
    """Substitui os itens da OV — ex.: item sem estoque trocado por outro.
    Bloqueado depois de FATURADO (o item vira o que está na NF).

    Responde 409 ESTOQUE_INSUFICIENTE quando o AUMENTO pedido não cabe no
    estoque; o operador confirma o parcial e reenvia com decisao_estoque."""
    return pedido_service.editar_itens(
        str(pedido_id), payload.itens, usuario,
        decisao=payload.decisao_estoque,
        observacao_estoque=payload.observacao_estoque,
        previsao_pcp=payload.previsao_pcp_iso(),
        escolha_estoque=payload.escolha_por_produto(),
    )


@router.post("/{pedido_id}/devolver-reserva")
def devolver_reserva(pedido_id: UUID, payload: DevolverReservaRequest,
                     usuario: UsuarioOut = Depends(get_current_user)):
    """Libera para o estoque parte do que esta OV reservou, jogando o saldo na
    pendência dela. Usado na tela de Estoque, no detalhe do comprometido."""
    return pedido_service.devolver_reserva(
        str(pedido_id), payload.codigo, payload.qtd, usuario, payload.observacao)


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


@router.post("/{pedido_id}/devolver-crm")
def devolver_ao_crm(
    pedido_id: UUID,
    payload: DevolverAoCrmRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    """Devolve ao comercial uma OV que nasceu do CRM, na etapa que ele escolher.

    A OV é cancelada e a oportunidade volta para o funil. Só vale antes de faturar —
    depois disso a OV é documento fiscal.
    """
    return pedido_service.devolver_ao_crm(
        str(pedido_id), payload.estagio, payload.motivo, usuario)


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

    # Desfaz o vínculo com a oportunidade do CRM, se houver.
    #
    # Sem isto a oportunidade continuava exibindo um link para uma OV cancelada e
    # se declarando com repasse CONCLUIDO — e, pior, a liberação da pendência de
    # estoque ficava travada, porque uma OV cancelada não aceita remessa derivada.
    # Soltando o vínculo, a venda volta para a fila de Repasse p/ OV e a pendência
    # volta a poder abrir uma OV nova.
    try:
        vinculadas = db.table("crm_oportunidades").select("id, titulo")\
            .eq("gerado_ov_id", str(pedido_id)).execute().data
        for opp in vinculadas:
            db.table("crm_oportunidades").update({
                "gerado_ov_id": None,
                "gerado_ov_ref": None,
                "repasse_status": "AGUARDANDO",
                "atualizado_em": agora,
            }).eq("id", opp["id"]).execute()
    except Exception:
        # Cancelar a OV é a operação principal e já foi feita; se a limpeza do
        # vínculo falhar (coluna ausente, CRM indisponível), não desfaz o resto.
        pass

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
_OPERACOES_FATURAMENTO = {"VENDA_NORMAL", "EXPORTACAO", "COMUNICADO_USO"}


def _conta_faturamento(pedido: dict) -> bool:
    # Legado sem tipo_operacao definido é tratado como venda normal.
    return (pedido.get("tipo_operacao") or "VENDA_NORMAL") in _OPERACOES_FATURAMENTO


def _eh_devolucao(pedido: dict) -> bool:
    return pedido.get("tipo_operacao") == "DEVOLUCAO"


def _canal_base(canal: Optional[str]) -> str:
    """Canal onde o faturamento é contabilizado. Licitação sempre cai no
    canal base (Uro ou Vascular); LICITACAO puro é legado sem base definida."""
    if canal == "LICITACAO_URO":
        return "URO"
    if canal == "LICITACAO_VASCULAR":
        return "VASCULAR"
    return canal or "SEM_CANAL"


def _eh_licitacao(pedido: dict) -> bool:
    """Licitação vem de `forma_venda`; o canal legado cobre as OVs antigas."""
    fv = pedido.get("forma_venda")
    if fv:
        return fv == "LICITACAO"
    return str(pedido.get("canal") or "").startswith("LICITACAO")


# O deploy do código sobe antes de a migration v13 rodar. Sem isto, pedir
# `forma_venda` no select derrubaria o Painel Comercial nesse intervalo — e a
# licitação já tem fallback no canal legado, então dá para viver sem a coluna.
_TEM_FORMA_VENDA: Optional[bool] = None


def _campos_pedido(db, base: str) -> str:
    """Acrescenta `forma_venda` ao select só se a coluna já existir."""
    global _TEM_FORMA_VENDA
    if _TEM_FORMA_VENDA is None:
        try:
            db.table("pedidos").select("forma_venda").limit(1).execute()
            _TEM_FORMA_VENDA = True
        except Exception:
            _TEM_FORMA_VENDA = False
    return base + (", forma_venda" if _TEM_FORMA_VENDA else "")


def _contexto_linha(db, ids: list) -> tuple:
    """Itens, produtos e mapa de linhas — o necessário para ratear por SKU.

    Um pacote só porque os três andam juntos em toda leitura que atribui receita
    a uma linha comercial.
    """
    from app.services import linha_produto
    itens_por_pedido: dict = {}
    for i in range(0, len(ids), 40):
        for it in db.table("itens_pedido").select(
                "pedido_id, produto_id, qtd_solicitada, valor_unitario"
        ).in_("pedido_id", ids[i:i + 40]).execute().data:
            itens_por_pedido.setdefault(it["pedido_id"], []).append(it)
    produtos = {p["id"]: p for p in db.table("produtos").select("id, codigo, familia").execute().data}
    return itens_por_pedido, produtos, linha_produto.mapa_por_codigo(db)


def _faturados_no_periodo(inicio: date, fim: date) -> dict:
    """pedido_id -> data de faturamento (BRT, ISO) das NFs faturadas no período.

    Atribui cada NF ao dia em que foi de fato faturada (movimentação para o
    status FATURADO), e não pela última atualização do pedido — que muda a
    cada mudança de status (coleta, expedição, etc.).

    A fonte da verdade é `pedidos.data_faturamento` (v31), gravada no instante do
    faturamento. A dedução pelas movimentações só entra quando ela falta.

    Nessa dedução vale a PRIMEIRA movimentação de FATURADO, porque correções em OV
    já faturada (trocar transportadora, corrigir valor) gravam uma movimentação
    repetindo o status — e a venda passava a contar também no mês da correção
    (3 OVs de julho reapareceram em agosto, R$ 4.939,84).

    Mas a dedução erra no caso oposto: OV REFATURADA. A OV016168 foi faturada em
    31/07 com uma NF emprestada por engano, revertida em 04/08 e refaturada em
    05/08 com a nota real — a primeira movimentação deixava R$ 5.600 em julho, mês
    errado, sobrando em julho e faltando em agosto contra o D365. Nenhuma
    heurística sobre o histórico acerta os dois casos; por isso a data gravada tem
    precedência, e refaturar a sobrescreve.
    """
    from datetime import datetime, timedelta, timezone
    from app.core.database import get_service_db
    db = get_service_db()

    def _data_brt(ts_str: Optional[str]):
        if not ts_str:
            return None
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            return (ts.astimezone(timezone.utc) - timedelta(hours=3)).date()
        except Exception:
            return None

    # Janela alargada em 1 dia para cobrir a conversão UTC->BRT nas bordas do mês.
    janela_ini = (inicio - timedelta(days=1)).isoformat()
    janela_fim = (fim + timedelta(days=1)).isoformat()

    # ── Fonte da verdade: a data gravada no faturamento ───────────────────────
    gravada: dict[str, str] = {}
    tem_coluna = True
    try:
        rows = db.table("pedidos").select("id, data_faturamento")\
            .gte("data_faturamento", f"{janela_ini}T00:00:00")\
            .lte("data_faturamento", f"{janela_fim}T23:59:59").execute().data
        for r in rows:
            if r.get("data_faturamento"):
                gravada[r["id"]] = r["data_faturamento"]
    except Exception:
        # Migration v31 pendente: segue só com a dedução pelas movimentações.
        tem_coluna = False

    # Quem TEM data gravada não deve ser datado pela movimentação — senão a OV
    # refaturada voltaria a contar no mês da primeira nota. Descobre esse conjunto
    # à parte da janela, porque a data gravada pode cair fora dela.
    com_data: set = set()
    if tem_coluna:
        try:
            todas = db.table("pedidos").select("id").not_is("data_faturamento", "null").execute().data
            com_data = {r["id"] for r in todas}
        except Exception:
            com_data = set(gravada)

    movs = db.table("movimentacoes").select(
        "pedido_id, criado_em"
    ).eq("status_novo", "FATURADO")\
        .gte("criado_em", f"{janela_ini}T00:00:00")\
        .lte("criado_em", f"{janela_fim}T23:59:59").execute().data

    candidatos = {m["pedido_id"] for m in movs
                  if m.get("pedido_id") and m["pedido_id"] not in com_data}
    if not candidatos and not gravada:
        return {}

    # Para os candidatos, busca TODAS as movimentações de FATURADO e fica com a
    # primeira — a data real da emissão da nota.
    ids_cand = list(candidatos)
    primeira: dict[str, str] = {}
    for i in range(0, len(ids_cand), 40):
        todas = db.table("movimentacoes").select("pedido_id, criado_em")\
            .eq("status_novo", "FATURADO").in_("pedido_id", ids_cand[i:i + 40]).execute().data
        for m in todas:
            pid, ts = m.get("pedido_id"), m.get("criado_em")
            if not pid or not ts:
                continue
            if pid not in primeira or ts < primeira[pid]:
                primeira[pid] = ts

    # A data gravada vence a deduzida.
    primeira.update(gravada)

    faturados: dict[str, str] = {}
    for pid, ts in primeira.items():
        d = _data_brt(ts)
        if d and inicio <= d <= fim:
            faturados[pid] = d.isoformat()
    if not faturados:
        return faturados

    # Faturamento é nota fiscal: sem número de NF, o pedido não conta. A
    # movimentação de FATURADO fica no histórico mesmo quando a OV volta atrás
    # no fluxo e a NF é removida (caso real: NF digitada por engano, OV
    # devolvida para Liberado) — sem este corte, o frete dela continuava sendo
    # descontado do faturamento e derrubava o total.
    ids = list(faturados.keys())
    com_nf: set = set()
    for i in range(0, len(ids), 40):
        rows = db.table("pedidos").select("id, numero_nf")\
            .in_("id", ids[i:i + 40]).execute().data
        com_nf.update(r["id"] for r in rows if (r.get("numero_nf") or "").strip())
    return {pid: dia for pid, dia in faturados.items() if pid in com_nf}


@router.get("/dashboard/financeiro")
def dashboard_financeiro(
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    """Faturamento NF e custo de frete das notas FATURADAS no período."""
    from app.core.database import get_service_db
    db = get_service_db()

    hoje = pedido_service._hoje_brt()
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
            if op in _OPERACOES_FATURAMENTO or op == "DEVOLUCAO":
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
            "devolucoes": vazio,
            "devolucoes_transfer": vazio,
            "outras_vendas_liquido": vazio,
            "transfer_price_liquido": vazio,
            "faturamento_liquido": vazio,
            "sem_faturamento": [],
        }

    ids = list(faturados.keys())
    pedidos = db.table("pedidos").select(
        "id, numero_nf, valor_nf, valor_produtos, valor_frete, tipo_frete, tipo_operacao, status, clientes(nome)"
    ).in_("id", ids).neq("status", "CANCELADO").execute().data

    # Só entram no faturamento bruto venda normal e comunicado de uso.
    faturaveis = [p for p in pedidos if _conta_faturamento(p)]
    transfer = [p for p in faturaveis if _eh_biomedical(p)]
    outras = [p for p in faturaveis if not _eh_biomedical(p)]

    # Devolução: nota de entrada estornando uma venda anterior. Não soma no
    # bruto, mas precisa subtrair do líquido — é o "Valor correto" do D365.
    devolucoes = [p for p in pedidos if _eh_devolucao(p) and not _eh_biomedical(p)]
    devolucoes_transfer = [p for p in pedidos if _eh_devolucao(p) and _eh_biomedical(p)]

    def _liquido(bruto: dict, devolucao: dict) -> dict:
        return {
            **bruto,
            "total_nf": round(bruto["total_nf"] + devolucao["total_nf"], 2),
            "faturamento_sem_frete": round(
                bruto["faturamento_sem_frete"] + devolucao["faturamento_sem_frete"], 2),
        }

    resumo_outras = _resumo(outras)
    resumo_devolucoes = _resumo(devolucoes)
    resumo_transfer = _resumo(transfer)
    resumo_dev_transfer = _resumo(devolucoes_transfer)
    total = _resumo(faturaveis)
    total_devolucoes = _resumo(devolucoes + devolucoes_transfer)

    return {
        "periodo": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
        **total,
        "transfer_price": resumo_transfer,
        "outras_vendas": resumo_outras,
        "devolucoes": resumo_devolucoes,
        "devolucoes_transfer": resumo_dev_transfer,
        "outras_vendas_liquido": _liquido(resumo_outras, resumo_devolucoes),
        "transfer_price_liquido": _liquido(resumo_transfer, resumo_dev_transfer),
        "faturamento_liquido": _liquido(total, total_devolucoes),
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

    hoje = pedido_service._hoje_brt()
    inicio = data_inicio or date(hoje.year, hoje.month, 1)
    fim = data_fim or hoje

    faturados = _faturados_no_periodo(inicio, fim)
    if not faturados:
        return []

    ids = list(faturados.keys())
    pedidos = db.table("pedidos").select(_campos_pedido(
        db, "id, numero_pedido, numero_nf, valor_nf, valor_produtos, valor_frete, "
            "tipo_frete, tipo_operacao, canal, status, clientes(nome)")
    ).in_("id", ids).neq("status", "CANCELADO").execute().data

    # A LINHA de cada NF sai dos itens, igual ao card por linha. Sem isso o
    # drill-down (que filtra no front) não fecharia com o total do card.
    from app.services import linha_produto
    itens_por_pedido, produtos, mapa_linha = _contexto_linha(db, ids)

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
            "forma_venda": p.get("forma_venda"),
            "eh_licitacao": _eh_licitacao(p),
            "eh_faturamento": _conta_faturamento(p),
            "eh_devolucao": _eh_devolucao(p),
            "valor_nf": round(bruto, 2),
            "valor_frete": round(valor_frete, 2),
            "valor_sem_frete": round(bruto - frete_na_nf, 2),
            "eh_biomedical": _eh_biomedical(p),
            "data": faturados.get(p["id"]),
            # {linha: valor} — quanto desta NF foi para cada meta.
            "linhas": linha_produto.ratear_por_linha(
                round(bruto - frete_na_nf, 2), itens_por_pedido.get(p["id"]) or [],
                produtos, mapa_linha, p.get("canal")),
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
    """Vendas (sem frete) por LINHA comercial no período, contra a meta da linha.

    Mesmo escopo de "Vendas": faturamento, sem Transfer Price nem Esterilize.

    A linha vem dos ITENS da OV (o SKU sabe a que meta pertence), e não do canal
    que alguém digitou. Muda duas coisas em relação ao que existia antes:

      · OV com itens de duas linhas é DIVIDIDA pelo valor de cada item, em vez
        de contar inteira para uma meta só;
      · canal digitado errado deixa de mandar a venda para a meta errada.

    O canal digitado continua sendo devolvido em `canais_digitado` — é como se
    confere a virada e se acham as OVs cujo palpite não batia com os itens.

    A licitação é um recorte transversal (vem de `forma_venda`): a mesma venda
    conta na linha dela e também aqui, para responder "quanto saiu por licitação
    no mês".
    """
    from app.core.database import get_service_db
    db = get_service_db()

    faturados = _faturados_no_periodo(data_inicio, data_fim)
    if not faturados:
        return {"canais": [], "licitacao": {"qtd": 0, "valor": 0.0},
                "canais_digitado": [], "sem_linha": {"qtd": 0, "valor": 0.0}}

    LABELS = {"URO": "Uro", "VASCULAR": "Vascular", "REALCLOSURE": "Realclosure", "LICITACAO": "Licitação"}
    ids = list(faturados.keys())

    from app.services import linha_produto
    itens_por_pedido, produtos, mapa_linha = _contexto_linha(db, ids)

    peds: list = []
    for i in range(0, len(ids), 40):
        peds += db.table("pedidos").select(_campos_pedido(
            db, "id, valor_nf, valor_frete, tipo_frete, tipo_operacao, canal, "
                "status, clientes(nome)")
        ).in_("id", ids[i:i + 40]).neq("status", "CANCELADO").execute().data

    agg: dict = {}            # por LINHA do SKU — a base da meta
    digitado: dict = {}       # por canal digitado — só para conferência
    licit = {"qtd": 0, "valor": 0.0}
    sem_linha = {"qtd": 0, "valor": 0.0}

    for p in peds:
        nome = ((p.get("clientes") or {}).get("nome") or "").upper()
        if "ESTERILIZE" in nome or _eh_biomedical(p) or not _conta_faturamento(p):
            continue
        valor = float(p.get("valor_nf") or 0)
        if p.get("tipo_frete") in ("CIF_SEM_VALOR", "CIF_COM_VALOR"):
            valor -= float(p.get("valor_frete") or 0)

        ck = _canal_base(p.get("canal"))
        d = digitado.setdefault(ck, {"canal": ck, "label": LABELS.get(ck, "Sem canal"),
                                     "qtd": 0, "valor": 0.0})
        d["qtd"] += 1
        d["valor"] += valor

        if _eh_licitacao(p):
            licit["qtd"] += 1
            licit["valor"] += valor

        rateio = linha_produto.ratear_por_linha(
            valor, itens_por_pedido.get(p["id"]) or [], produtos, mapa_linha, p.get("canal"))
        if not rateio:
            # Nem itens cadastrados nem canal legado: não há como afirmar a linha.
            sem_linha["qtd"] += 1
            sem_linha["valor"] += valor
            continue
        for linha, v in rateio.items():
            g = agg.setdefault(linha, {"canal": linha, "linha": linha,
                                       "label": linha_produto.label(linha),
                                       "qtd": 0, "valor": 0.0})
            g["valor"] += v
            # A NF dividida conta em CADA linha que ela toca: é o que o
            # drill-down lista. A soma das contagens pode passar do total de NFs
            # do mês, e é isso mesmo — uma NF de duas linhas aparece nas duas.
            g["qtd"] += 1

    for g in list(agg.values()) + list(digitado.values()):
        g["valor"] = round(g["valor"], 2)
    licit["valor"] = round(licit["valor"], 2)
    sem_linha["valor"] = round(sem_linha["valor"], 2)
    if sem_linha["qtd"]:
        agg["SEM_CANAL"] = {"canal": "SEM_CANAL", "linha": None, "label": "Sem linha",
                            "qtd": sem_linha["qtd"], "valor": sem_linha["valor"]}
    return {
        "canais": sorted(agg.values(), key=lambda x: -x["valor"]),
        "licitacao": licit,
        # O que o canal digitado diria — para conferir a virada, não para a meta.
        "canais_digitado": sorted(digitado.values(), key=lambda x: -x["valor"]),
        "sem_linha": sem_linha,
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
    """Quantidade vendida por produto, a partir dos itens das OVs faturadas no
    período — mesmo escopo de "Vendas" dos demais cards (venda normal e
    comunicado de uso, sem Transfer Price nem Esterilize).

    Antes usava a coluna "Venda" do inventário contínuo (por data da
    contagem física, não da NF) — trocado porque contagem é um passo
    operacional, não a origem da venda; a OV é.
    """
    from app.core.database import get_service_db
    db = get_service_db()

    faturados = _faturados_no_periodo(data_inicio, data_fim)
    if not faturados:
        return []

    ids = list(faturados.keys())
    pedidos: list = []
    for i in range(0, len(ids), 40):
        pedidos += db.table("pedidos").select(
            "id, tipo_operacao, status, clientes(nome)"
        ).in_("id", ids[i:i + 40]).neq("status", "CANCELADO").execute().data

    ids_vendas = [
        p["id"] for p in pedidos
        if _conta_faturamento(p) and not _eh_biomedical(p)
        and "ESTERILIZE" not in ((p.get("clientes") or {}).get("nome") or "").upper()
    ]
    if not ids_vendas:
        return []

    itens: list = []
    for i in range(0, len(ids_vendas), 40):
        itens += db.table("itens_pedido").select(
            "pedido_id, qtd_solicitada, produtos(codigo, descricao)"
        ).in_("pedido_id", ids_vendas[i:i + 40]).execute().data

    agg: dict = {}
    for it in itens:
        qtd = float(it.get("qtd_solicitada") or 0)
        produto = it.get("produtos") or {}
        cod = (produto.get("codigo") or "").strip()
        if qtd <= 0 or not cod:
            continue
        g = agg.setdefault(cod, {"codigo": cod, "descricao": produto.get("descricao"), "qtd": 0.0})
        g["qtd"] += qtd

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
    hoje = pedido_service._hoje_brt().isoformat()
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
