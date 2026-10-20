# -*- coding: utf-8 -*-
"""Conferência da fatura de frete — sobe o zip da transportadora e confere."""
from datetime import date
from typing import Optional
from uuid import UUID

from pydantic import BaseModel

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import frete_service, programacao_service, tabela_frete_service

router = APIRouter(tags=["frete"])

# 40 MB. O pacote de 16 a 31/08 tem 6 MB com 88 arquivos; o teto é folga para um
# período cheio, e existe para um upload errado não virar timeout.
TETO = 40 * 1024 * 1024


@router.get("/programacao-coleta")
def programacao_coleta(
    data: Optional[str] = None,
    transportadora: str = "BRIX",
    _: UsuarioOut = Depends(get_current_user),
):
    """As cargas que saem no dia, para conferir antes de mandar."""
    dia = date.fromisoformat(data) if data else date.today()
    return {"data": dia.isoformat(), "transportadora": transportadora,
            "linhas": programacao_service.listar(dia, transportadora)}


@router.get("/programacao-coleta/planilha")
def programacao_coleta_planilha(
    data: Optional[str] = None,
    transportadora: str = "BRIX",
    _: UsuarioOut = Depends(get_current_user),
):
    """O xlsx no modelo da transportadora, pronto para mandar no grupo."""
    dia = date.fromisoformat(data) if data else date.today()
    conteudo = programacao_service.planilha(dia, transportadora)
    nome = "Programacao de coleta %s - %s.xlsx" % (
        dia.strftime("%d-%m-%Y"), transportadora)
    return Response(
        content=conteudo,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="%s"' % nome})


@router.get("/frete/tabela")
def tabela_contratada(_: UsuarioOut = Depends(get_current_user)):
    """A tabela de frete contratada, como ela esta no app."""
    return tabela_frete_service.tabela()


@router.get("/frete/estimativa")
def estimativa(
    uf: Optional[str] = None,
    cidade: Optional[str] = None,
    peso_kg: float = 0,
    m3: float = 0,
    valor_nf: float = 0,
    _: UsuarioOut = Depends(get_current_user),
):
    """Quanto a transportadora deve cobrar nesta carga, pela tabela."""
    return tabela_frete_service.estimar(uf, cidade, peso_kg, m3, valor_nf)


@router.get("/frete/estimativa/pedido/{pedido_id}")
def estimativa_do_pedido(pedido_id: UUID,
                         _: UsuarioOut = Depends(get_current_user)):
    """A estimativa desta OV: le a cubagem, o destino e o valor da nota.

    Dimensoes vem em cm e a tabela cobra por m3 — a conversao fica aqui para a
    tela nao ter de saber disso."""
    from app.core.database import get_service_db
    db = get_service_db()

    ped = db.table("pedidos").select(
        "id, numero_pedido, numero_nf, local_entrega, valor_nf, valor_produtos"
    ).eq("id", str(pedido_id)).execute().data
    if not ped:
        raise HTTPException(status_code=404, detail="OV nao encontrada")
    p = ped[0]

    cub = db.table("cubagem").select(
        "num_caixas, peso_kg, altura_cm, largura_cm, comprimento_cm"
    ).eq("pedido_id", str(pedido_id)).execute().data
    c = cub[0] if cub else {}
    caixas = float(c.get("num_caixas") or 0) or 1
    m3 = 0.0
    if c.get("altura_cm") and c.get("largura_cm") and c.get("comprimento_cm"):
        m3 = (float(c["altura_cm"]) * float(c["largura_cm"])
              * float(c["comprimento_cm"]) / 1_000_000) * caixas

    local = (p.get("local_entrega") or "").strip()
    cidade, uf = None, None
    if "/" in local:
        cidade, uf = local.rsplit("/", 1)
        cidade, uf = cidade.strip(), uf.strip().upper()[:2]

    # Ad valorem e GRIS sao percentual do valor da mercadoria. Na cotacao a NF
    # ainda nao existe, entao o valor vem dos ITENS — sem isso as duas taxas
    # saiam zeradas justamente na hora de cotar, que e quando o numero serve.
    valor = float(p.get("valor_nf") or 0) or float(p.get("valor_produtos") or 0)
    base_valor = "nota fiscal" if p.get("valor_nf") else (
        "valor de produtos" if p.get("valor_produtos") else None)
    if not valor:
        itens = db.table("itens_pedido").select(
            "qtd_solicitada, valor_unitario").eq("pedido_id", str(pedido_id)).execute().data
        valor = sum(float(i.get("qtd_solicitada") or 0) * float(i.get("valor_unitario") or 0)
                    for i in itens)
        base_valor = "itens da OV" if valor else None

    r = tabela_frete_service.estimar(
        uf, cidade, peso_kg=float(c.get("peso_kg") or 0) * caixas, m3=m3,
        valor_nf=valor)
    r["tem_cubagem"] = bool(cub)
    r["valor_mercadoria"] = round(valor, 2)
    r["base_valor"] = base_valor
    r["local_entrega"] = local or None
    return r


@router.post("/frete/conferencia")
async def conferir(
    arquivo: UploadFile = File(...),
    # A conversa onde o frete e cotado. Opcional: sem ela a conferencia roda
    # igual, so nao consegue dizer se a cobranca a mais foi combinada.
    conversa: Optional[UploadFile] = File(None),
    transportadora: Optional[str] = Form(None),
    gravar: bool = Form(True),
    usuario: UsuarioOut = Depends(get_current_user),
):
    """Confere o pacote da transportadora contra as nossas OVs."""
    conteudo = await arquivo.read()
    if not conteudo:
        raise HTTPException(422, "arquivo vazio")
    if len(conteudo) > TETO:
        raise HTTPException(413, "arquivo acima de 40 MB")
    bytes_conversa, nome_conversa = None, ""
    if conversa is not None:
        bytes_conversa = await conversa.read()
        nome_conversa = conversa.filename or ""
        if len(bytes_conversa) > TETO:
            raise HTTPException(413, "a conversa esta acima de 40 MB")
    return frete_service.conferir(
        conteudo, arquivo.filename or "pacote.zip",
        transportadora=transportadora, gravar=gravar, usuario=usuario,
        conversa=bytes_conversa, conversa_nome=nome_conversa)


class DefinirTransportadora(BaseModel):
    transportadora_id: UUID


@router.get("/frete/gastos")
def gastos(meses: int = 6, _: UsuarioOut = Depends(get_current_user)):
    """Quanto a MSB gasta de frete, por transportadora e por mês."""
    return frete_service.gastos(meses)


@router.patch("/frete/pedido/{numero}/transportadora")
def definir_transportadora(numero: str, payload: DefinirTransportadora,
                           usuario: UsuarioOut = Depends(get_current_user)):
    """Diz qual transportadora levou um pedido que estava sem."""
    return frete_service.definir_transportadora(
        numero, str(payload.transportadora_id), usuario)


@router.get("/frete/a-pagar")
def a_pagar(de: str, ate: str, transportadora: str = "",
            _: UsuarioOut = Depends(get_current_user)):
    """Quanto a MSB deve a cada transportadora no periodo, OV por OV.

    Diferente de /frete/gastos, que mede CUSTO (so CIF sem valor): a fatura da
    transportadora cobra os dois CIF. Sem o com-valor, os CORREIOS apareciam
    zerados e a BRIX com um terco do que deve.
    """
    return frete_service.relatorio_a_pagar(de, ate, transportadora or None)


@router.get("/frete/ov/{numero}")
def analise_ov(numero: str, _: UsuarioOut = Depends(get_current_user)):
    """O que a conferência sabe de uma OV, com o veredito escrito."""
    return frete_service.analise_ov(numero)


@router.get("/frete/conferencias")
def listar(limite: int = 24, _: UsuarioOut = Depends(get_current_user)):
    """O histórico guardado — os últimos 3 meses."""
    return frete_service.listar(limite)


@router.get("/frete/conferencias/{conferencia_id}")
def detalhe(conferencia_id: str, _: UsuarioOut = Depends(get_current_user)):
    return frete_service.detalhe(conferencia_id)
