from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import get_current_user
from app.models.schemas import (
    AtividadeCreate,
    AtividadeUpdate,
    ContatoCreate,
    ContatoUpdate,
    ClienteRapidoCreate,
    CotacaoCreate,
    CotacaoUpdate,
    GanharRequest,
    GerarOVRequest,
    DesafioCreate,
    DesafioUpdate,
    EmpresaContatoRequest,
    EmpresaCreate,
    EmpresaUpdate,
    DisponibilidadeRequest,
    AcompanharPendenciaRequest,
    ReordenarFilaRequest,
    AjustarItensPendenciaRequest, LiberarPendenciaRequest,
    NotaCreate,
    OportunidadeCreate,
    OportunidadeUpdate,
    PerderRequest,
    UsuarioOut,
)
from app.services import (
    crm_cotacao_service,
    crm_empresas_service,
    crm_service,
    disponibilidade_service,
    pendencia_service,
)

router = APIRouter(prefix="/crm", tags=["crm"])


# ── Dashboard ────────────────────────────────────────────────────────────────────
@router.get("/dashboard")
def dashboard(_: UsuarioOut = Depends(get_current_user)):
    return crm_service.dashboard()


# ── Clientes (cadastro rápido pelo comercial) ──────────────────────────────────────
@router.post("/clientes", status_code=201)
def criar_cliente_rapido(payload: ClienteRapidoCreate, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_cliente_rapido(payload.nome, payload.cnpj)


# ── Contatos ─────────────────────────────────────────────────────────────────────
@router.get("/contatos")
def listar_contatos(cliente_id: Optional[UUID] = Query(None), _: UsuarioOut = Depends(get_current_user)):
    return crm_service.listar_contatos(str(cliente_id) if cliente_id else None)


@router.post("/contatos", status_code=201)
def criar_contato(payload: ContatoCreate, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_contato(payload)


@router.get("/contatos/{contato_id}")
def obter_contato(contato_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.obter_contato(str(contato_id))


@router.patch("/contatos/{contato_id}")
def atualizar_contato(contato_id: UUID, payload: ContatoUpdate, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.atualizar_contato(str(contato_id), payload)


@router.delete("/contatos/{contato_id}")
def excluir_contato(contato_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.excluir_contato(str(contato_id))


# ── Oportunidades ────────────────────────────────────────────────────────────────
@router.get("/oportunidades")
def listar_oportunidades(
    estagio: Optional[str] = Query(None),
    incluir_fechadas: bool = Query(False),
    _: UsuarioOut = Depends(get_current_user),
):
    return crm_service.listar_oportunidades(estagio, incluir_fechadas)


@router.post("/oportunidades", status_code=201)
def criar_oportunidade(payload: OportunidadeCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_oportunidade(payload, usuario)


@router.get("/oportunidades/{oportunidade_id}")
def obter_oportunidade(oportunidade_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.obter_oportunidade(str(oportunidade_id))


@router.patch("/oportunidades/{oportunidade_id}")
def atualizar_oportunidade(
    oportunidade_id: UUID,
    payload: OportunidadeUpdate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return crm_service.atualizar_oportunidade(str(oportunidade_id), payload, usuario)


@router.post("/oportunidades/{oportunidade_id}/ganhar")
def ganhar_oportunidade(oportunidade_id: UUID, payload: Optional[GanharRequest] = None,
                        usuario: UsuarioOut = Depends(get_current_user)):
    """Responde 409 com `tipo: ESTOQUE_INSUFICIENTE` e a análise item a item
    quando falta material. O front abre o modal de decisão e reenvia com
    `decisao_estoque`."""
    return crm_service.ganhar_oportunidade(
        str(oportunidade_id), usuario,
        payload.repasse_nota if payload else None,
        decisao_estoque=payload.decisao_estoque if payload else None,
        observacao_estoque=payload.observacao_estoque if payload else None,
        previsao_pcp=payload.previsao_pcp_iso() if payload else None)


# ── Estoque da venda: disponibilidade e pendência ────────────────────────────────
@router.get("/oportunidades/{oportunidade_id}/disponibilidade")
def disponibilidade_oportunidade(oportunidade_id: UUID,
                                 sincronizar: bool = Query(False),
                                 _: UsuarioOut = Depends(get_current_user)):
    """Quanto dos itens desta oportunidade existe em estoque. Só informa — não
    grava nem decide nada. Por padrão usa a última foto do PCP sem ir buscar
    outra, para a tela abrir na hora."""
    return crm_service.disponibilidade(str(oportunidade_id), sincronizar=sincronizar)


@router.post("/disponibilidade")
def disponibilidade_de_itens(payload: DisponibilidadeRequest,
                             _: UsuarioOut = Depends(get_current_user)):
    """A mesma consulta para itens que ainda não foram gravados — o formulário
    de nova oportunidade e o de venda outbound perguntam enquanto o comercial
    digita."""
    return disponibilidade_service.analisar([{
        "ref": idx,
        "produto_id": str(i.produto_id) if i.produto_id else None,
        "codigo": i.codigo,
        "descricao": i.descricao,
        "qtd": i.qtd,
        "valor_unitario": i.valor_unitario,
    } for idx, i in enumerate(payload.itens)])


@router.get("/pendencias")
def listar_pendencias(incluir_resolvidas: bool = Query(False),
                      _: UsuarioOut = Depends(get_current_user)):
    """Pendências de estoque dos dois fluxos (CRM e outbound) num formato só —
    alimenta a coluna do kanban e a aba do Painel Comercial."""
    return pendencia_service.listar(incluir_resolvidas=incluir_resolvidas)


@router.get("/pendencias/por-produto")
def pendencias_por_produto(_: UsuarioOut = Depends(get_current_user)):
    """As pendências agregadas por PRODUTO: qual item segura mais dinheiro e
    quantos clientes esperam pelo mesmo material.

    Declarada antes das rotas com {fonte} para o caminho fixo não ser capturado
    como parâmetro."""
    return pendencia_service.por_produto()


@router.post("/pendencias/{fonte}/{registro_id}/liberar")
def liberar_pendencia(fonte: str, registro_id: UUID,
                      payload: Optional[LiberarPendenciaRequest] = None,
                      usuario: UsuarioOut = Depends(get_current_user)):
    """Manda o saldo para a expedição agora que há material. `fonte` é
    'oportunidade' (venda do CRM) ou 'pedido' (venda outbound) — o mesmo valor
    que vem no campo `fonte` de cada item de /crm/pendencias.

    Reconfere o estoque: responde 409 com a análise se o material ainda não
    chegou por completo, e aí o front pode reenviar com `parcial: true`."""
    return pendencia_service.liberar(
        fonte, str(registro_id), usuario,
        parcial=payload.parcial if payload else False,
        observacao=payload.observacao if payload else None,
        itens_escolhidos=payload.itens if payload else None)


@router.post("/pendencias/ordem")
def reordenar_fila(payload: ReordenarFilaRequest,
                   usuario: UsuarioOut = Depends(get_current_user)):
    """Define à mão a ordem da fila de material.

    Quem está mais alto recebe primeiro quando o estoque não dá para todos. Fica
    ANTES de /pendencias/{fonte}/... na ordem das rotas: "ordem" casaria com o
    parâmetro `fonte` se viesse depois.
    """
    return pendencia_service.reordenar(
        [{"fonte": i.fonte, "id": str(i.id)} for i in payload.ordem], usuario)


@router.post("/pendencias/ordem/automatica")
def fila_automatica(usuario: UsuarioOut = Depends(get_current_user)):
    """Devolve a fila ao critério automático: quem espera há mais tempo primeiro."""
    return pendencia_service.ordem_automatica(usuario)


@router.post("/pendencias/{fonte}/{registro_id}/itens")
def ajustar_itens_pendencia(fonte: str, registro_id: UUID,
                            payload: AjustarItensPendenciaRequest,
                            usuario: UsuarioOut = Depends(get_current_user)):
    """Inclui ou remove item de uma pendência aberta, direto da tela de Pendências.

    Antes só dava para corrigir isto no registro de origem — a oportunidade do
    CRM ou a OV. Quem estava olhando a lista errada tinha de sair da tela, achar
    o registro e voltar; na prática ficava como estava.

    Mexer aqui mexe na VENDA: incluir sobe o valor, remover desce. Item que já
    teve entrega parcial é recusado com 409 — ali a correção é na OV, porque o
    material saiu de verdade.
    """
    return pendencia_service.ajustar_itens(
        fonte, str(registro_id), usuario,
        adicionar=[{
            "produto_id": str(i.produto_id),
            "qtd": i.qtd,
            "valor_unitario": i.valor_unitario,
        } for i in (payload.adicionar or [])],
        remover=[str(r) for r in (payload.remover or [])],
        atualizar=[{
            "produto_id": str(i.produto_id),
            "qtd": i.qtd,
            "valor_unitario": i.valor_unitario,
        } for i in (payload.atualizar or [])],
        observacao=payload.observacao)


@router.patch("/pendencias/{fonte}/{registro_id}")
def acompanhar_pendencia(fonte: str, registro_id: UUID,
                         payload: AcompanharPendenciaRequest,
                         usuario: UsuarioOut = Depends(get_current_user)):
    """Anota o que se apurou sobre uma pendência: quando o material vem e o que o
    PCP respondeu. Não libera nada e não mexe em item — para isso existe
    .../liberar."""
    return pendencia_service.acompanhar(
        fonte, str(registro_id), usuario,
        previsao_pcp=payload.previsao_pcp.isoformat() if payload.previsao_pcp else None,
        observacao=payload.observacao,
        limpar_previsao=payload.limpar_previsao)


# A fila "Repasse p/ OV" (GET /repasses e POST .../assumir) foi removida junto com
# a aba do CRM: ganhar já abre a OV em "Dados da OV", e venda sem material fica na
# coluna Pendência. A fila só existia para um passo manual que não existe mais — e
# na prática mandava operações de vendas cadastrar OV de venda sem estoque.
#
# `crm_service.ganhas_sem_ov` continua, agora como DETECTOR de anomalia (ganha, sem
# OV e sem pendência = a criação da OV falhou), alimentando a tela de Início e o
# resumo do Teams.


@router.get("/oportunidades/{oportunidade_id}/requisitos")
def requisitos_avanco(oportunidade_id: UUID, destino: str = Query(...),
                      _: UsuarioOut = Depends(get_current_user)):
    """O que falta para a oportunidade entrar em `destino`.

    A tela consulta antes de oferecer o botão, para o vendedor ver o que buscar em
    vez de tomar um erro depois de tentar mover o card."""
    from app.core.database import get_service_db
    db = get_service_db()
    atual = db.table("crm_oportunidades").select("*").eq("id", str(oportunidade_id)).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Oportunidade não encontrada")
    falta = crm_service.requisitos_avanco(db, str(oportunidade_id), atual, destino)
    return {"destino": destino, "pode_avancar": not falta, "falta": falta}


@router.get("/motivos-perda")
def motivos_perda(_: UsuarioOut = Depends(get_current_user)):
    return [{"key": k, "label": v} for k, v in crm_service.MOTIVOS_PERDA.items()]


@router.post("/oportunidades/{oportunidade_id}/perder")
def perder_oportunidade(oportunidade_id: UUID, payload: PerderRequest, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.perder_oportunidade(str(oportunidade_id), payload, usuario)


@router.post("/oportunidades/{oportunidade_id}/gerar-ov")
def gerar_ov(oportunidade_id: UUID, payload: GerarOVRequest, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.gerar_ov(str(oportunidade_id), payload, usuario)


@router.post("/oportunidades/{oportunidade_id}/notas")
def criar_nota(oportunidade_id: UUID, payload: NotaCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_nota(str(oportunidade_id), payload, usuario)


@router.delete("/oportunidades/{oportunidade_id}")
def excluir_oportunidade(oportunidade_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.excluir_oportunidade(str(oportunidade_id))


# ── Atividades ───────────────────────────────────────────────────────────────────
@router.get("/atividades")
def listar_atividades(
    escopo: str = Query("abertas"),
    oportunidade_id: Optional[UUID] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return crm_service.listar_atividades(escopo, str(oportunidade_id) if oportunidade_id else None)


@router.post("/atividades", status_code=201)
def criar_atividade(payload: AtividadeCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_atividade(payload, usuario)


@router.patch("/atividades/{atividade_id}")
def atualizar_atividade(atividade_id: UUID, payload: AtividadeUpdate, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.atualizar_atividade(str(atividade_id), payload)


@router.post("/atividades/{atividade_id}/concluir")
def concluir_atividade(
    atividade_id: UUID,
    concluida: bool = Query(True),
    _: UsuarioOut = Depends(get_current_user),
):
    return crm_service.concluir_atividade(str(atividade_id), concluida)


@router.delete("/atividades/{atividade_id}")
def excluir_atividade(atividade_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.excluir_atividade(str(atividade_id))


# ── Empresas (prospectadas e qualificadas) ──────────────────────────────────────
@router.get("/empresas/opcoes")
def opcoes_empresa(_: UsuarioOut = Depends(get_current_user)):
    """Vocabulário do fluxo (tipos, portes, papéis, janelas, motivos, fontes)."""
    return crm_empresas_service.opcoes()


@router.get("/empresas")
def listar_empresas(estado: Optional[str] = Query(None), _: UsuarioOut = Depends(get_current_user)):
    """Empresas ativas. `estado=PROSPECTADA` ou `QUALIFICADA` filtra o banco."""
    return crm_empresas_service.listar_empresas(estado)


@router.post("/empresas", status_code=201)
def criar_empresa(payload: EmpresaCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_empresas_service.criar_empresa(payload, usuario)


@router.get("/empresas/{empresa_id}")
def obter_empresa(empresa_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_empresas_service.obter_empresa(str(empresa_id))


@router.patch("/empresas/{empresa_id}")
def atualizar_empresa(empresa_id: UUID, payload: EmpresaUpdate,
                      usuario: UsuarioOut = Depends(get_current_user)):
    return crm_empresas_service.atualizar_empresa(str(empresa_id), payload, usuario)


@router.post("/empresas/{empresa_id}/contato")
def registrar_contato_empresa(empresa_id: UUID, payload: EmpresaContatoRequest,
                              usuario: UsuarioOut = Depends(get_current_user)):
    """Registra interação. É movimentação real: zera o relógio do ciclo de 1 ano."""
    return crm_empresas_service.registrar_contato(str(empresa_id), payload, usuario)


@router.post("/empresas/{empresa_id}/gerar-oportunidade")
def gerar_oportunidade(empresa_id: UUID, usuario: UsuarioOut = Depends(get_current_user)):
    """Cria o card no funil a partir de uma empresa qualificada."""
    return crm_empresas_service.gerar_oportunidade(str(empresa_id), usuario)


@router.delete("/empresas/{empresa_id}")
def excluir_empresa(empresa_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_empresas_service.excluir_empresa(str(empresa_id))


# ── Desafios ────────────────────────────────────────────────────────────────────
@router.get("/desafios/tipos")
def listar_tipos_desafio(q: Optional[str] = Query(None), _: UsuarioOut = Depends(get_current_user)):
    """Autocomplete dos tipos, mais usados primeiro — evita criar variações do
    mesmo problema."""
    return crm_service.listar_tipos_desafio(q)


@router.get("/oportunidades/{oportunidade_id}/desafios")
def listar_desafios(oportunidade_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.listar_desafios(str(oportunidade_id))


@router.post("/oportunidades/{oportunidade_id}/desafios", status_code=201)
def criar_desafio(oportunidade_id: UUID, payload: DesafioCreate,
                  usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_desafio(str(oportunidade_id), payload, usuario)


@router.patch("/desafios/{desafio_id}")
def atualizar_desafio(desafio_id: UUID, payload: DesafioUpdate,
                      usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.atualizar_desafio(str(desafio_id), payload, usuario)


# ── Cotações ─────────────────────────────────────────────────────────────────────
@router.get("/cotacoes")
def listar_cotacoes(status: Optional[str] = Query(None), oportunidade_id: Optional[UUID] = Query(None),
                    _: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.listar_cotacoes(status, str(oportunidade_id) if oportunidade_id else None)


@router.post("/cotacoes", status_code=201)
def criar_cotacao(payload: CotacaoCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.criar_cotacao(payload, usuario)


@router.get("/cotacoes/{cotacao_id}")
def obter_cotacao(cotacao_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.obter_cotacao(str(cotacao_id))


@router.patch("/cotacoes/{cotacao_id}")
def atualizar_cotacao(cotacao_id: UUID, payload: CotacaoUpdate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.atualizar_cotacao(str(cotacao_id), payload, usuario)


@router.post("/cotacoes/{cotacao_id}/duplicar", status_code=201)
def duplicar_cotacao(cotacao_id: UUID, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.duplicar_cotacao(str(cotacao_id), usuario)


@router.post("/cotacoes/{cotacao_id}/gerar-ov", status_code=201)
def gerar_ov_cotacao(cotacao_id: UUID, payload: GerarOVRequest, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.gerar_ov(str(cotacao_id), payload, usuario)


@router.delete("/cotacoes/{cotacao_id}")
def excluir_cotacao(cotacao_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.excluir_cotacao(str(cotacao_id))


# A Inteligência saiu daqui e virou módulo próprio (app/api/inteligencia.py,
# rota /inteligencia): não depende do funil do CRM e o público é a diretoria.
