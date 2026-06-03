from typing import Optional
from fastapi import APIRouter, Depends, Query

from app.core.database import get_service_db
from app.core.deps import get_current_user, lider_ou_superior
from app.models.schemas import (
    ClienteCreate, ClienteOut,
    LoteCreate, LoteOut,
    ProdutoCreate, ProdutoOut,
    TransportadoraCreate, TransportadoraOut,
    UsuarioOut,
)

router = APIRouter(tags=["cadastros"])


# ── Ocorrências (listagem geral) ───────────────────────────────────────────────

@router.get("/ocorrencias")
def listar_ocorrencias(
    status: Optional[str] = None,
    _: UsuarioOut = Depends(get_current_user),
):
    db = get_service_db()
    query = db.table("ocorrencias").select(
        "*, pedidos(numero_pedido, status, clientes(nome))"
    )
    if status:
        query = query.eq("status", status)
    result = query.order("criado_em", desc=True).execute()
    dados = result.data if result.data else []
    # Normaliza: adiciona numero_pedido no nível raiz
    for o in dados:
        pedido = o.pop("pedidos", None)
        o["numero_pedido"] = pedido.get("numero_pedido", "—") if pedido else "—"
        o["pedido_status"] = pedido.get("status", "") if pedido else ""
        o["cliente_nome"] = (pedido.get("clientes") or {}).get("nome", "—") if pedido else "—"
    return dados


# ── Tipos de Caixa ────────────────────────────────────────────────────────────

@router.get("/tipos-caixa")
def listar_tipos_caixa(
    search: Optional[str] = None,
    _: UsuarioOut = Depends(get_current_user),
):
    db = get_service_db()
    query = db.table("tipos_caixa").select("*").eq("ativo", True)
    if search and len(search) >= 1:
        query = query.ilike("codigo", f"%{search}%")
    return query.order("codigo").limit(20).execute().data


@router.post("/tipos-caixa", status_code=201)
def criar_tipo_caixa(payload: dict, _: UsuarioOut = Depends(get_current_user)):
    db = get_service_db()
    return db.table("tipos_caixa").insert({
        "codigo": payload["codigo"],
        "descricao": payload.get("descricao", ""),
        "ativo": True,
    }).execute().data[0]


# ── Itens de Cubagem ───────────────────────────────────────────────────────────

@router.get("/pedidos-cubagem/{pedido_id}/itens")
def listar_cubagem_itens(pedido_id: str, _: UsuarioOut = Depends(get_current_user)):
    db = get_service_db()
    return db.table("cubagem_itens").select("*, tipos_caixa(codigo, descricao)").eq("pedido_id", pedido_id).execute().data


@router.post("/pedidos-cubagem/{pedido_id}/itens")
def salvar_cubagem_itens(pedido_id: str, payload: dict, _: UsuarioOut = Depends(get_current_user)):
    """Salva itens de cubagem (substitui os anteriores)."""
    db = get_service_db()
    import uuid as _uuid
    # Remove itens anteriores
    db.table("cubagem_itens").delete().eq("pedido_id", pedido_id).execute()
    itens = payload.get("itens", [])
    if itens:
        db.table("cubagem_itens").insert([{
            "id": str(_uuid.uuid4()),
            "pedido_id": pedido_id,
            "tipo_caixa_id": item.get("tipo_caixa_id"),
            "tipo_caixa_nome": item.get("tipo_caixa_nome"),
            "quantidade": item.get("quantidade", 1),
        } for item in itens]).execute()
    return {"ok": True, "total_itens": len(itens)}


# ── Motivos de Ocorrência ──────────────────────────────────────────────────────

@router.get("/motivos-ocorrencia")
def listar_motivos(tipo: Optional[str] = None, _: UsuarioOut = Depends(get_current_user)):
    db = get_service_db()
    query = db.table("motivos_ocorrencia").select("*").eq("ativo", True)
    if tipo:
        query = query.eq("tipo", tipo)
    return query.order("descricao").execute().data


@router.post("/motivos-ocorrencia", status_code=201)
def criar_motivo(payload: dict, _: UsuarioOut = Depends(get_current_user)):
    db = get_service_db()
    return db.table("motivos_ocorrencia").insert({
        "tipo": payload.get("tipo", "TRANSPORTADORA"),
        "descricao": payload["descricao"],
        "ativo": True,
    }).execute().data[0]


@router.delete("/motivos-ocorrencia/{motivo_id}")
def desativar_motivo(motivo_id: str, _: UsuarioOut = Depends(get_current_user)):
    db = get_service_db()
    db.table("motivos_ocorrencia").update({"ativo": False}).eq("id", motivo_id).execute()
    return {"ok": True}


# ── Clientes ───────────────────────────────────────────────────────────────────

@router.get("/clientes", response_model=list[ClienteOut])
def listar_clientes(
    search: Optional[str] = Query(None),
    _: UsuarioOut = Depends(get_current_user)
):
    db = get_service_db()
    query = db.table("clientes").select("*").eq("ativo", True)
    if search:
        query = query.ilike("nome", f"%{search}%")
    return query.order("nome").limit(50).execute().data


@router.post("/clientes", response_model=ClienteOut, status_code=201)
def criar_cliente(payload: ClienteCreate, _: UsuarioOut = Depends(lider_ou_superior)):
    db = get_service_db()
    return db.table("clientes").insert({**payload.model_dump(), "ativo": True}).execute().data[0]


# ── Transportadoras ────────────────────────────────────────────────────────────

@router.get("/transportadoras", response_model=list[TransportadoraOut])
def listar_transportadoras(_: UsuarioOut = Depends(get_current_user)):
    db = get_service_db()
    return db.table("transportadoras").select("*").eq("ativo", True).order("nome").execute().data


@router.post("/transportadoras", response_model=TransportadoraOut, status_code=201)
def criar_transportadora(payload: TransportadoraCreate, _: UsuarioOut = Depends(lider_ou_superior)):
    db = get_service_db()
    return db.table("transportadoras").insert({**payload.model_dump(), "ativo": True}).execute().data[0]


# ── Produtos ───────────────────────────────────────────────────────────────────

@router.get("/produtos", response_model=list[ProdutoOut])
def listar_produtos(
    search: Optional[str] = None,
    _: UsuarioOut = Depends(get_current_user)
):
    db = get_service_db()
    query = db.table("produtos").select("*").eq("ativo", True)
    if search:
        # Busca por código OU descrição
        query = query.ilike("codigo", f"%{search}%")
    return query.order("codigo").limit(20).execute().data


@router.get("/produtos/busca")
def buscar_produtos(
    q: str = "",
    _: UsuarioOut = Depends(get_current_user)
):
    """Busca produtos por código OU descrição — para autocomplete."""
    db = get_service_db()
    if not q or len(q) < 2:
        return []
    # Busca por código
    por_codigo = db.table("produtos").select("*").eq("ativo", True).ilike("codigo", f"%{q}%").order("codigo").limit(10).execute().data
    # Busca por descrição (complementa até 10 resultados)
    por_desc = db.table("produtos").select("*").eq("ativo", True).ilike("descricao", f"%{q}%").order("codigo").limit(10).execute().data
    # Mescla sem duplicar
    vistos = {p["id"] for p in por_codigo}
    resultado = por_codigo + [p for p in por_desc if p["id"] not in vistos]
    return resultado[:10]


@router.post("/produtos", response_model=ProdutoOut, status_code=201)
def criar_produto(payload: ProdutoCreate, _: UsuarioOut = Depends(lider_ou_superior)):
    db = get_service_db()
    return db.table("produtos").insert({**payload.model_dump(), "ativo": True}).execute().data[0]


# ── Lotes ──────────────────────────────────────────────────────────────────────

@router.get("/produtos/{produto_id}/lotes", response_model=list[LoteOut])
def listar_lotes(produto_id: str, _: UsuarioOut = Depends(get_current_user)):
    db = get_service_db()
    return db.table("lotes").select("*").eq("produto_id", produto_id).order("validade").execute().data


@router.post("/lotes", response_model=LoteOut, status_code=201)
def criar_lote(payload: LoteCreate, _: UsuarioOut = Depends(get_current_user)):
    db = get_service_db()
    data = payload.model_dump()
    data["produto_id"] = str(data["produto_id"])
    if data.get("validade"):
        data["validade"] = data["validade"].isoformat()
    return db.table("lotes").insert(data).execute().data[0]
