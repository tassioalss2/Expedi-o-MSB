from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.deps import get_current_user
from app.models.schemas import (
    ConsumoEmpenhoCreate,
    DemandaConcluir,
    DemandaCreate,
    DemandaEstoqueCreate,
    DemandaEstoqueLiberar,
    DemandaFreteCreate,
    DemandaNFEnvioCreate,
    DemandaUpdate,
    EmpenhoCreate,
    EntregaVendaDiretaCreate,
    NeCreate,
    PregaoCreate,
    UsuarioOut,
)
from app.services import licitacao_demanda_service, licitacao_service, pregao_service

router = APIRouter(prefix="/licitacoes", tags=["licitacoes"])


# ── Pregões (mestre) ─────────────────────────────────────────────────────────────

@router.get("/pregoes")
def listar_pregoes(_: UsuarioOut = Depends(get_current_user)):
    return pregao_service.listar_pregoes()


@router.post("/pregoes", status_code=201)
def criar_pregao(payload: PregaoCreate, _: UsuarioOut = Depends(get_current_user)):
    return pregao_service.criar_pregao(payload)


@router.get("/pregoes/{pregao_id}")
def obter_pregao(pregao_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return pregao_service.obter_pregao(str(pregao_id))


@router.put("/pregoes/{pregao_id}")
def atualizar_pregao(pregao_id: UUID, payload: PregaoCreate, _: UsuarioOut = Depends(get_current_user)):
    return pregao_service.atualizar_pregao(str(pregao_id), payload)


@router.post("/pregoes/{pregao_id}/nes", status_code=201)
def criar_ne(pregao_id: UUID, payload: NeCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return pregao_service.criar_ne(str(pregao_id), payload, usuario)


@router.delete("/pregoes/{pregao_id}")
def excluir_pregao(pregao_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return pregao_service.excluir_pregao(str(pregao_id))


@router.get("/empenhos")
def listar_empenhos(_: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.listar_empenhos()


@router.post("/empenhos", status_code=201)
def criar_empenho(payload: EmpenhoCreate, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.criar_empenho(payload)


@router.get("/empenhos/{empenho_id}")
def obter_empenho(empenho_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.obter_empenho(str(empenho_id))


@router.post("/empenhos/{empenho_id}/consumo", status_code=201)
def registrar_consumo(
    empenho_id: UUID,
    payload: ConsumoEmpenhoCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return licitacao_service.registrar_consumo(str(empenho_id), payload, usuario)


@router.post("/empenhos/{empenho_id}/entrega", status_code=201)
def registrar_entrega(
    empenho_id: UUID,
    payload: EntregaVendaDiretaCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return licitacao_service.registrar_entrega(str(empenho_id), payload, usuario)


@router.delete("/empenhos/{empenho_id}")
def excluir_empenho(empenho_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.excluir_empenho(str(empenho_id))


# ── Painel de demandas (triagem Kanban) ─────────────────────────────────────────

@router.get("/demandas")
def listar_demandas(_: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.listar_demandas()


@router.get("/demandas/historico/datas")
def historico_datas(_: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.historico_datas()


@router.get("/demandas/historico")
def historico_demandas(data: str, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.historico_demandas(data)


@router.get("/demandas/historico/buscar")
def historico_buscar(q: str, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.historico_buscar(q)


@router.get("/demandas/relatorio")
def relatorio(
    tipo: str | None = None,
    canal: str | None = None,
    data_inicio: str | None = None,
    data_fim: str | None = None,
    _: UsuarioOut = Depends(get_current_user),
):
    return licitacao_demanda_service.relatorio(tipo, canal, data_inicio, data_fim)


@router.post("/demandas", status_code=201)
def criar_demanda(payload: DemandaCreate, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.criar_demanda(payload)


@router.get("/demandas/{demanda_id}")
def obter_demanda(demanda_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.obter_demanda(str(demanda_id))


@router.patch("/demandas/{demanda_id}")
def atualizar_demanda(demanda_id: UUID, payload: DemandaUpdate, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.atualizar_demanda(str(demanda_id), payload)


@router.post("/demandas/{demanda_id}/concluir")
def concluir_demanda(
    demanda_id: UUID,
    payload: DemandaConcluir,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return licitacao_demanda_service.concluir_demanda(str(demanda_id), payload, usuario)


class VincularOVRequest(BaseModel):
    numero_pedido: str


@router.post("/demandas/{demanda_id}/vincular-ov")
def vincular_ov(demanda_id: UUID, payload: VincularOVRequest, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.vincular_ov(str(demanda_id), payload.numero_pedido)


@router.post("/demandas/{demanda_id}/gerar-ov", status_code=201)
def gerar_ov_saldo(
    demanda_id: UUID,
    payload: EntregaVendaDiretaCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return licitacao_demanda_service.gerar_ov_saldo(str(demanda_id), payload, usuario)


@router.post("/demandas/{demanda_id}/frete")
def registrar_frete(demanda_id: UUID, payload: DemandaFreteCreate, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.registrar_frete(str(demanda_id), payload)


@router.post("/demandas/{demanda_id}/enviar-nf")
def enviar_nf(demanda_id: UUID, payload: DemandaNFEnvioCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.enviar_nf(str(demanda_id), payload, usuario)


@router.post("/demandas/{demanda_id}/sem-estoque")
def marcar_sem_estoque(demanda_id: UUID, payload: DemandaEstoqueCreate, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.marcar_sem_estoque(str(demanda_id), payload)


@router.post("/demandas/{demanda_id}/estoque-ok")
def liberar_estoque(demanda_id: UUID, payload: DemandaEstoqueLiberar, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.liberar_estoque(str(demanda_id), payload)


@router.delete("/demandas/{demanda_id}")
def excluir_demanda(demanda_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.excluir_demanda(str(demanda_id))
