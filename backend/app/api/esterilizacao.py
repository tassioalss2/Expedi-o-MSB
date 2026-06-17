from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.core.deps import get_current_user
from app.models.enums_esterilizacao import StatusCarga
from app.models.schemas_esterilizacao import (
    AlterarStatusCargaRequest,
    BloquearCargaRequest,
    CargaCreate,
    CargaUpdate,
    ConcluirEtapaRequest,
    IniciarEtapaRequest,
    ItemCargaCreate,
    LiberarCargaRequest,
    ProdutoEsterilCreate,
    ProdutoEsterilUpdate,
    RegistrarEnvioRequest,
    RegistrarRetornoRequest,
    SimularCargaRequest,
)
from app.models.schemas import UsuarioOut
from app.services import esterilizacao_service as svc

router = APIRouter(prefix="/esterilizacao", tags=["esterilizacao"])


# ── Produtos Estéreis ─────────────────────────────────────────────────────────

@router.get("/produtos")
def listar_produtos(
    familia: Optional[str] = Query(None),
    busca: Optional[str] = Query(None),
    ativo_only: bool = Query(True),
    _: UsuarioOut = Depends(get_current_user),
):
    return svc.listar_produtos(familia=familia, busca=busca, ativo_only=ativo_only)


@router.get("/produtos/familias")
def listar_familias(_: UsuarioOut = Depends(get_current_user)):
    return svc.familias_disponiveis()


@router.post("/produtos", status_code=201)
def criar_produto(payload: ProdutoEsterilCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return svc.criar_produto(payload, usuario.nome)


@router.patch("/produtos/{codigo_sa}")
def atualizar_produto(
    codigo_sa: str,
    payload: ProdutoEsterilUpdate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.atualizar_produto(codigo_sa, payload, usuario.nome)


# ── Simulação ─────────────────────────────────────────────────────────────────

@router.post("/simular")
def simular_carga(payload: SimularCargaRequest, _: UsuarioOut = Depends(get_current_user)):
    return svc.simular_carga(payload)


# ── Cargas ────────────────────────────────────────────────────────────────────

@router.post("/cargas", status_code=201)
def criar_carga(payload: CargaCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return svc.criar_carga(payload, usuario.nome)


@router.get("/cargas")
def listar_cargas(
    status: Optional[str] = Query(None),
    mes: Optional[int] = Query(None),
    ano: Optional[int] = Query(None),
    prioridade: Optional[str] = Query(None),
    atrasadas: Optional[bool] = Query(None),
    data_saida_inicio: Optional[date] = Query(None),
    data_saida_fim: Optional[date] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return svc.listar_cargas(
        status=status,
        mes=mes,
        ano=ano,
        prioridade=prioridade,
        atrasadas=atrasadas,
        data_saida_inicio=data_saida_inicio,
        data_saida_fim=data_saida_fim,
    )


@router.get("/cargas/{carga_id}")
def obter_carga(carga_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return svc.obter_carga(str(carga_id))


@router.patch("/cargas/{carga_id}")
def atualizar_carga(
    carga_id: UUID,
    payload: CargaUpdate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.atualizar_carga(str(carga_id), payload, usuario.nome)


@router.post("/cargas/{carga_id}/liberar")
def liberar_carga(
    carga_id: UUID,
    payload: LiberarCargaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.liberar_carga(str(carga_id), payload, usuario.nome)


@router.patch("/cargas/{carga_id}/status")
def alterar_status(
    carga_id: UUID,
    payload: AlterarStatusCargaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.alterar_status(str(carga_id), payload.novo_status, usuario.nome, payload.observacao)


@router.post("/cargas/{carga_id}/bloquear")
def bloquear_carga(
    carga_id: UUID,
    payload: BloquearCargaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.bloquear_carga(str(carga_id), payload.motivo, usuario.nome)


@router.post("/cargas/{carga_id}/enviar")
def registrar_envio(
    carga_id: UUID,
    payload: RegistrarEnvioRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.registrar_envio(str(carga_id), payload, usuario.nome)


@router.post("/cargas/{carga_id}/retorno")
def registrar_retorno(
    carga_id: UUID,
    payload: RegistrarRetornoRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.registrar_retorno(str(carga_id), payload, usuario.nome)


# ── Itens da Carga ────────────────────────────────────────────────────────────

@router.post("/cargas/{carga_id}/itens", status_code=201)
def adicionar_item(
    carga_id: UUID,
    payload: ItemCargaCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.adicionar_item(str(carga_id), payload, usuario.nome)


@router.delete("/cargas/{carga_id}/itens/{item_id}")
def remover_item(
    carga_id: UUID,
    item_id: UUID,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.remover_item(str(carga_id), str(item_id), usuario.nome)


# ── Apontamentos ──────────────────────────────────────────────────────────────

@router.post("/cargas/{carga_id}/apontamentos/iniciar")
def iniciar_etapa(
    carga_id: UUID,
    payload: IniciarEtapaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.iniciar_etapa(str(carga_id), payload.etapa.value, payload.operador, usuario.nome)


@router.patch("/cargas/{carga_id}/apontamentos/{apontamento_id}/concluir")
def concluir_etapa(
    carga_id: UUID,
    apontamento_id: UUID,
    payload: ConcluirEtapaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return svc.concluir_etapa(str(carga_id), str(apontamento_id), payload.observacao, payload.problema_reportado, usuario.nome)


@router.get("/cargas/{carga_id}/apontamentos")
def listar_apontamentos(carga_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return svc.listar_apontamentos(str(carga_id))


# ── Histórico ─────────────────────────────────────────────────────────────────

@router.get("/cargas/{carga_id}/historico")
def listar_historico(carga_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return svc.listar_historico(str(carga_id))


# ── Dashboard ─────────────────────────────────────────────────────────────────

@router.get("/dashboard")
def dashboard(
    mes: int = Query(..., ge=1, le=12),
    ano: int = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    return svc.dashboard(mes, ano)
