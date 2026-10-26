from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.cadastros import router as cadastros_router
from app.api.crm import router as crm_router
from app.api.esterilizacao import router as esterilizacao_router
from app.api.impressao import router as impressao_router
from app.api.inventario import router as inventario_router
from app.api.inventario_continuo import router as inventario_continuo_router
from app.api.frete import router as frete_router
from app.api.licitacoes import router as licitacoes_router
from app.api.localidades import router as localidades_router
from app.api.pedidos import router as pedidos_router
from app.api.previsao import router as previsao_router
from app.api.estoque import router as estoque_router
from app.api.home import router as home_router
from app.api.inteligencia import router as inteligencia_router
from app.api.d365 import router as d365_router
from app.api.devolucoes import router as devolucoes_router
from app.api.notas_d365 import router as notas_d365_router
from app.api.rastreio import router as rastreio_router
from app.api.coletas import router as coletas_router

app = FastAPI(
    title="ACE-MSB — Aplicativo de Controle de Expedição",
    version="1.0.0",
    description="API de gestão de expedição da MSB Biomedical",
)

import os
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")



# O que o perfil BIO alcanca. Lista branca, e nao lista de proibidos: o app
# cresce toda semana, e uma tela nova nasceria aberta para eles se a regra fosse
# "tudo menos X". Aqui ela nasce fechada.
#
# E o conjunto exato do que as duas telas deles chamam — kanban da expedicao
# (com Nova OV e o detalhe) e rastreio de entregas.
ESCOPO_BIO = (
    "/api/v1/auth",
    "/api/v1/pedidos",
    "/api/v1/rastreio",
    "/api/v1/pallets",
    "/api/v1/clientes",
    "/api/v1/transportadoras",
    "/api/v1/produtos",
    "/api/v1/estoque",
    "/api/v1/localidades",
    "/api/v1/frete/prazo",
    "/api/v1/frete/estimativa",
    "/api/v1/impressao",
    "/api/v1/inventario/ultimo-lote",
    "/api/v1/motivos-ocorrencia",
    "/api/v1/ocorrencias",
    "/api/v1/crm/disponibilidade",
)

# Dentro de /pedidos moram os paineis de dinheiro — faturamento, meta, vendas
# por cliente. Eles ficam de fora mesmo com /pedidos liberado.
FORA_DO_ESCOPO_BIO = (
    "/api/v1/pedidos/dashboard",
    "/api/v1/pedidos/meta",
    "/api/v1/pedidos/indicadores",
)


def _perfil_do_token(request) -> str:
    cabecalho = request.headers.get("authorization") or ""
    if not cabecalho.lower().startswith("bearer "):
        return ""
    try:
        from app.core.security import decode_token
        dados = decode_token(cabecalho.split(" ", 1)[1]) or {}
    except Exception:
        return ""
    # str(...) e o split: o perfil vai para o token como enum de string e
    # serializa como "CONSELHO", mas comparar com o valor cru quebraria em
    # silencio se um dia virasse "PerfilUsuario.CONSELHO" — e quebrar em
    # silencio aqui significa liberar acesso.
    return str(dados.get("perfil") or "").split(".")[-1]


@app.middleware("http")
async def escopo_da_biomedical(request, call_next):
    """O perfil BIO so enxerga as duas telas combinadas.

    A Biomedical lanca pedido para a MSB e acompanha a entrega. Faturamento,
    margem, CRM, licitacao e indicadores nao sao assunto dela — e esconder o
    menu nao basta, porque a URL continua la para quem digitar.
    """
    if _perfil_do_token(request) == "BIO":
        caminho = request.url.path
        liberado = (caminho.startswith(ESCOPO_BIO)
                    and not caminho.startswith(FORA_DO_ESCOPO_BIO))
        if not liberado and caminho.startswith("/api/"):
            from fastapi.responses import JSONResponse
            return JSONResponse(
                status_code=403,
                content={"detail": "Seu acesso cobre os pedidos e o rastreio de entregas."})
    return await call_next(request)


@app.middleware("http")
async def somente_leitura_para_o_conselho(request, call_next):
    """O perfil CONSELHO acompanha e não opera.

    O bloqueio é aqui, e não em cada rota, por um motivo prático: das ~136
    rotas de escrita do app, 15 passam pela dependência de permissão. Gatear
    por dependência protegeria 11% e daria a sensação de estar protegido — e a
    próxima rota que alguém criar nasceria desprotegida de novo. Um método que
    não é GET simplesmente não passa, e não há como esquecer.

    Lê o perfil do próprio token para não ir ao banco em toda requisição; o
    token é assinado, então o perfil que vem nele é confiável para NEGAR. Quem
    autoriza de verdade continua sendo `get_current_user`, que carrega o
    usuário do banco.
    """
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        cabecalho = request.headers.get("authorization") or ""
        if cabecalho.lower().startswith("bearer "):
            try:
                from app.core.security import decode_token
                dados = decode_token(cabecalho.split(" ", 1)[1]) or {}
            except Exception:
                dados = {}
            # str(...) e o split: o perfil vai para o token como enum de string
            # e serializa como "CONSELHO", mas comparar com o valor cru
            # quebraria em silencio se um dia virasse "PerfilUsuario.CONSELHO"
            # — e quebrar em silencio aqui significa liberar escrita.
            perfil = str(dados.get("perfil") or "").split(".")[-1]
            if perfil == "CONSELHO":
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Seu acesso é de acompanhamento: "
                                       "esta ação altera dados e não está liberada."},
                )
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Produção: qualquer origem (Vercel gera URLs dinâmicas)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api/v1")
app.include_router(pedidos_router, prefix="/api/v1")
app.include_router(cadastros_router, prefix="/api/v1")
app.include_router(inventario_router, prefix="/api/v1")
app.include_router(inventario_continuo_router, prefix="/api/v1")
app.include_router(licitacoes_router, prefix="/api/v1")
app.include_router(frete_router, prefix="/api/v1")
app.include_router(localidades_router, prefix="/api/v1")
app.include_router(impressao_router, prefix="/api/v1")
app.include_router(esterilizacao_router, prefix="/api/v1")
app.include_router(crm_router, prefix="/api/v1")
app.include_router(previsao_router, prefix="/api/v1")
app.include_router(estoque_router, prefix="/api/v1")
app.include_router(home_router, prefix="/api/v1")
app.include_router(inteligencia_router, prefix="/api/v1")
app.include_router(d365_router, prefix="/api/v1")
app.include_router(devolucoes_router, prefix="/api/v1")
app.include_router(notas_d365_router, prefix="/api/v1")
app.include_router(rastreio_router, prefix="/api/v1")
app.include_router(coletas_router, prefix="/api/v1")


@app.on_event("startup")
def iniciar_agendador_resumo():
    """Resumo diário no Teams (08h BRT, seg-sex) — thread leve, sem dependências."""
    from app.services import resumo_service
    resumo_service.iniciar_agendador()


@app.get("/health")
def health():
    return {"status": "ok", "app": "ACE-MSB"}
