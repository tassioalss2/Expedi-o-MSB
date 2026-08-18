from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.models.schemas import AjusteEstoqueRequest, UsuarioOut
from app.services import estoque_service

router = APIRouter(prefix="/estoque", tags=["estoque"])


@router.get("")
def listar(_: UsuarioOut = Depends(get_current_user)):
    """Estoque disponível por item (foto do PCP de hoje − OVs comprometidas).

    Sincroniza a foto do PCP se ainda não houver a de hoje — a primeira abertura
    do dia atualiza para todo mundo."""
    return estoque_service.listar()


@router.post("/sincronizar")
def sincronizar(_: UsuarioOut = Depends(get_current_user)):
    """Força a sincronização com o app do PCP (botão 'Sincronizar agora'), para
    quando o PCP publica a planilha depois de alguém já ter aberto a tela."""
    return estoque_service.sincronizar(forcar=True)


@router.get("/disponivel")
def disponivel_por_codigo(_: UsuarioOut = Depends(get_current_user)):
    """Só o disponível por código, enxuto — para o seletor de itens mostrar o
    estoque na hora em que o vendedor escolhe o produto.

    Uma chamada devolve TODOS os SKUs (algumas centenas de linhas curtas), em vez
    de uma consulta por item escolhido. O seletor guarda em cache e responde na
    hora. Fica ANTES de /{codigo}/... na ordem das rotas de propósito: "disponivel"
    casaria com o parâmetro `codigo` se viesse depois.
    """
    return estoque_service.disponivel_por_codigo()


@router.post("/ajuste")
def ajustar_estoque(payload: AjusteEstoqueRequest,
                    usuario: UsuarioOut = Depends(get_current_user)):
    """Corrige à mão o PA da foto de hoje — para quando a divergência trava uma OV.

    Não altera a foto do PCP: o ajuste é uma camada por cima, e vale só para a
    foto de hoje. Amanhã o PCP volta a mandar.

    Fica ANTES de /{codigo}/... na ordem das rotas: "ajuste" casaria com o
    parâmetro `codigo` se viesse depois.
    """
    from fastapi import HTTPException
    try:
        return estoque_service.ajustar(payload.codigo, payload.estoque_pa,
                                       payload.motivo, str(usuario.id))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        # A tabela do ajuste é nova (migration v15): sem ela, dizer o que falta é
        # melhor do que um 500 sem explicação.
        raise HTTPException(status_code=500,
                            detail=f"Não foi possível gravar o ajuste: {e}")


@router.get("/{codigo}/ajustes")
def historico_ajustes(codigo: str, _: UsuarioOut = Depends(get_current_user)):
    """Ajustes manuais já feitos num código — quem, quando, de quanto para quanto."""
    return estoque_service.ajustes_do_codigo(codigo)


@router.get("/{codigo}/comprometido")
def comprometido_detalhe(codigo: str, _: UsuarioOut = Depends(get_current_user)):
    """As OVs por trás do número de 'comprometido' de um item — clicar na coluna
    do estoque abre isto, para auditar de onde vem a conta."""
    return estoque_service.comprometido_detalhe(codigo)


@router.get("/{codigo}/historico-vendas")
def historico_vendas(codigo: str, _: UsuarioOut = Depends(get_current_user)):
    """Vendido por mês (últimos 6 meses de calendário) e tendência (30d vs 30d
    anteriores) de um item — para o modal de histórico de vendas."""
    return estoque_service.historico_vendas(codigo)
