from datetime import date
from typing import Optional
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
from app.services import (
    licitacao_demanda_service,
    licitacao_entrada_service,
    licitacao_service,
    pregao_service,
)

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


@router.get("/demandas/{demanda_id}/estoque-pcp")
def estoque_pcp_da_demanda(demanda_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    """Cobertura de estoque dos itens da demanda, lida do app do PCP.

    Endpoint separado de /demandas/{id} de propósito: é uma chamada a um sistema
    externo, então não pode atrasar nem derrubar o carregamento do card."""
    from app.services import pcp_estoque_service
    demanda = licitacao_demanda_service.obter_demanda(str(demanda_id))
    return pcp_estoque_service.cobertura_da_demanda(demanda)


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


# ── Caixa de entrada da licitação (a triagem que saiu do Excel) ─────────────────
class EntradaTriar(BaseModel):
    """O que uma pessoa decide sobre um caso.

    PARCIAL não é enfeite: na triagem de 03/09/2026 o time escreveu "Parcial" à
    mão em 3 das 218 linhas de uma planilha que só oferecia Sim/Nao.
    """
    situacao: Optional[str] = None        # NAO | PARCIAL | SIM
    observacao: Optional[str] = None
    cliente_id: Optional[UUID] = None
    # Eixo separado da situacao: um caso em tratativa continua "em aberto" ate
    # ser atendido. Marcar PARCIAL para sinalizar que alguem pegou o caso seria
    # mentir sobre o atendimento, que e o numero que o conselho acompanha.
    em_tratativa: Optional[bool] = None


class EntradaPromover(BaseModel):
    """O que a tela preenche e o anexo não tinha.

    O comunicado de uso exige paciente, prontuário e data do procedimento —
    nada disso está no anexo do pedido, então quem promove informa.
    """
    tipo_operacao: Optional[str] = None
    cliente_id: Optional[UUID] = None
    numero: Optional[str] = None
    numero_pregao: Optional[str] = None
    canal: Optional[str] = None
    prazo: Optional[date] = None
    prioridade: Optional[str] = None
    observacao: Optional[str] = None
    nome_paciente: Optional[str] = None
    prontuario: Optional[str] = None
    numero_nf: Optional[str] = None
    data_procedimento: Optional[date] = None
    # Segunda demanda para a mesma NE só quando alguém pede de propósito: duas
    # demandas para o mesmo empenho é o pedido duplicado que o processo evita.
    permitir_segunda: bool = False


class OrgaoMapear(BaseModel):
    cnpj: str
    cliente_id: UUID
    nome_documento: Optional[str] = None


@router.get("/entrada")
def listar_entrada(situacao: Optional[str] = None, dias: int = 60,
                   tipo: Optional[str] = None,
                   _: UsuarioOut = Depends(get_current_user)):
    return licitacao_entrada_service.listar(situacao, dias, tipo)


@router.get("/entrada/detalhe")
def detalhe_do_numero(metrica: str, dias: int = 30,
                      _: UsuarioOut = Depends(get_current_user)):
    """Os casos por tras de um numero do painel, e de onde ele vem.

    Existe porque numero que nao se explica vira discussao sobre o numero, e
    nao sobre o processo — foi o que aconteceu com o faturamento do app contra
    o D365. Devolve o filtro em palavras, a origem do dado e a lista de casos.
    """
    return licitacao_entrada_service.detalhe(metrica, dias)


@router.get("/entrada/painel")
def painel_entrada(dias: int = 30, _: UsuarioOut = Depends(get_current_user)):
    """Visão de fluxo do setor. É o que o conselho acompanha."""
    return licitacao_entrada_service.painel(dias)


@router.get("/entrada/orgaos")
def listar_orgaos(_: UsuarioOut = Depends(get_current_user)):
    return licitacao_entrada_service.listar_orgaos()


@router.get("/entrada/orgaos/pendentes")
def orgaos_pendentes(_: UsuarioOut = Depends(get_current_user)):
    """Órgãos vistos nos e-mails que ainda não têm cliente definido.

    Enquanto um órgão está aqui, os pedidos dele não podem virar demanda: a
    demanda exige cliente, e adivinhar o cliente errado é pior que travar.
    """
    return licitacao_entrada_service.orgaos_pendentes()


@router.post("/entrada/orgaos")
def mapear_orgao(payload: OrgaoMapear, usuario: UsuarioOut = Depends(get_current_user)):
    return licitacao_entrada_service.mapear_orgao(
        payload.cnpj, str(payload.cliente_id), usuario, payload.nome_documento)


@router.patch("/entrada/{entrada_id}")
def triar_entrada(entrada_id: UUID, payload: EntradaTriar,
                  usuario: UsuarioOut = Depends(get_current_user)):
    return licitacao_entrada_service.triar(
        str(entrada_id), usuario, payload.situacao, payload.observacao,
        str(payload.cliente_id) if payload.cliente_id else None,
        payload.em_tratativa)


@router.post("/entrada/grupo/triar")
def triar_grupo(chave: str, payload: EntradaTriar,
                usuario: UsuarioOut = Depends(get_current_user)):
    """Decide a nota de empenho inteira — é como o time trabalha."""
    return licitacao_entrada_service.triar_grupo(
        chave, usuario, payload.situacao, payload.observacao,
        str(payload.cliente_id) if payload.cliente_id else None,
        payload.em_tratativa)


@router.post("/entrada/grupo/promover")
def promover_grupo(chave: str, payload: EntradaPromover,
                   usuario: UsuarioOut = Depends(get_current_user)):
    """Transforma o pedido recebido na demanda que a operação vai executar."""
    extra = payload.model_dump(exclude_none=True)
    if payload.cliente_id:
        extra["cliente_id"] = str(payload.cliente_id)
    return licitacao_entrada_service.promover(chave, usuario, extra)
