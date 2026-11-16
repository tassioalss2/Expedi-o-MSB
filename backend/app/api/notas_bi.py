# -*- coding: utf-8 -*-
"""Base de Notas Fiscais do BI — o faturamento item a item."""
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import notas_bi_service

router = APIRouter(prefix="/notas-bi", tags=["Faturamento (BI)"])

# A base de um mês tem ~300 linhas. O teto existe para um arquivo errado não
# virar timeout, não porque o certo chegue perto disso.
TETO = 25 * 1024 * 1024


async def _ler(arquivo: UploadFile) -> bytes:
    conteudo = await arquivo.read()
    if not conteudo:
        raise HTTPException(422, "arquivo vazio")
    if len(conteudo) > TETO:
        raise HTTPException(413, "arquivo acima de 25 MB")
    return conteudo


@router.post("/previa")
async def previa(arquivo: UploadFile = File(...),
                 _: UsuarioOut = Depends(get_current_user)):
    """O que a importação traria, sem gravar nada."""
    try:
        return notas_bi_service.previa(await _ler(arquivo), arquivo.filename or "")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/importar")
async def importar(arquivo: UploadFile = File(...),
                   usuario: UsuarioOut = Depends(get_current_user)):
    """Lê a base do BI e atualiza o espelho item a item."""
    try:
        return notas_bi_service.importar(await _ler(arquivo),
                                         arquivo.filename or "", usuario)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/resumo")
def resumo(
    competencia: Optional[str] = Query(None, description="AAAAMM"),
    _: UsuarioOut = Depends(get_current_user),
):
    """O que a base responde: produto, cliente, linha e vertical.

    Soma sempre com o sinal que veio — devolução entra negativa, e o número
    que aparece é o líquido. É o mesmo princípio do painel comercial.
    """
    from app.core.database import get_service_db
    db = get_service_db()

    q = db.table("notas_bi_itens").select(
        "numero_fatura, data_faturamento, competencia, linha, sales_vertical, "
        "tipo_cliente, cliente_codigo, cliente_nome, uf, familia, "
        "produto_codigo, produto_nome, valor, quantidade, preco, vendedor")
    if competencia:
        q = q.eq("competencia", competencia)
    linhas = q.limit(20000).execute().data

    def agrupar(chave, rotulo=None):
        acc = {}
        for l in linhas:
            k = l.get(chave) or "—"
            a = acc.setdefault(k, {"chave": k, "valor": 0.0, "qtd": 0.0, "notas": set()})
            a["valor"] += float(l.get("valor") or 0)
            a["qtd"] += float(l.get("quantidade") or 0)
            a["notas"].add(l.get("numero_fatura"))
            if rotulo and not a.get("rotulo"):
                a["rotulo"] = l.get(rotulo)
        saida = []
        for a in acc.values():
            saida.append({"chave": a["chave"], "rotulo": a.get("rotulo"),
                          "valor": round(a["valor"], 2), "qtd": round(a["qtd"], 2),
                          "notas": len(a["notas"])})
        return sorted(saida, key=lambda x: -x["valor"])

    competencias = sorted({l.get("competencia") for l in linhas if l.get("competencia")})
    devol = [l for l in linhas if float(l.get("valor") or 0) < 0]
    return {
        "competencia": competencia,
        "competencias": competencias,
        "linhas": len(linhas),
        "notas": len({l.get("numero_fatura") for l in linhas}),
        "valor": round(sum(float(l.get("valor") or 0) for l in linhas), 2),
        "quantidade": round(sum(float(l.get("quantidade") or 0) for l in linhas), 2),
        "devolucoes": {"linhas": len(devol),
                       "valor": round(sum(float(l.get("valor") or 0) for l in devol), 2)},
        "por_linha": agrupar("linha"),
        "por_vertical": agrupar("sales_vertical"),
        "por_tipo_cliente": agrupar("tipo_cliente"),
        "por_produto": agrupar("produto_codigo", rotulo="produto_nome")[:25],
        "por_familia": agrupar("familia")[:20],
        "por_cliente": agrupar("cliente_nome")[:25],
        "por_uf": agrupar("uf"),
    }


@router.get("/precos/{produto_codigo}")
def precos_do_produto(produto_codigo: str,
                      _: UsuarioOut = Depends(get_current_user)):
    """O preço praticado deste item, cliente a cliente.

    Preço é por cliente — o mesmo item sai a R$ 14,00 para um e R$ 32,00 para
    outro, e isso é a regra comercial, não divergência. Esta rota mostra a
    dispersão sem chamar nenhuma ponta de errada.
    """
    from app.core.database import get_service_db
    db = get_service_db()
    linhas = db.table("notas_bi_itens").select(
        "cliente_nome, cliente_codigo, tipo_cliente, preco, quantidade, valor, "
        "data_faturamento, numero_fatura").eq(
        "produto_codigo", produto_codigo).order(
        "data_faturamento", desc=True).limit(500).execute().data
    vendas = [l for l in linhas if float(l.get("quantidade") or 0) > 0 and l.get("preco")]
    precos = [float(l["preco"]) for l in vendas]
    return {
        "produto_codigo": produto_codigo,
        "ocorrencias": len(vendas),
        "preco_minimo": min(precos) if precos else None,
        "preco_maximo": max(precos) if precos else None,
        "clientes": len({l.get("cliente_codigo") for l in vendas}),
        "linhas": vendas,
    }
