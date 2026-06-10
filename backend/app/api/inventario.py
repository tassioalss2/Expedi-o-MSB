from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import get_current_user, lider_ou_superior
from app.models.schemas import (
    AdicionarPedidoPalletRequest,
    CubagemCreate,
    InventarioSalvar,
    PalletCreate,
    UsuarioOut,
    VerificarFisicoRequest,
)
from app.services import inventario_service

router = APIRouter(tags=["inventario"])


# ── Inventário Contínuo ───────────────────────────────────────

@router.post("/pedidos/{pedido_id}/inventario")
def salvar_inventario(
    pedido_id: UUID,
    payload: InventarioSalvar,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.salvar_inventario(str(pedido_id), payload, usuario)


@router.get("/pedidos/{pedido_id}/inventario")
def listar_inventario(
    pedido_id: UUID,
    _: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.listar_inventario(str(pedido_id))


class TratativaDivergenciaRequest(BaseModel):
    acao: str  # "corrigir_inventario" | "resolver"
    justificativa: str


@router.post("/pedidos/{pedido_id}/divergencia/tratar")
def tratar_divergencia(
    pedido_id: UUID,
    payload: TratativaDivergenciaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    from app.core.database import get_service_db
    from app.services.inventario_service import _agora, _get_usuario_real
    from app.models.enums import StatusPedido

    db = get_service_db()
    uid = _get_usuario_real(str(usuario.id))

    # Fecha a ocorrência aberta relacionada
    ocorrencias = db.table("ocorrencias").select("id").eq("pedido_id", str(pedido_id)).eq("status", "ABERTA").execute().data
    for oc in ocorrencias:
        db.table("ocorrencias").update({
            "status": "FECHADA",
            "resolucao": payload.justificativa,
            "resolvido_por": uid,
            "resolvido_em": _agora(),
        }).eq("id", oc["id"]).execute()

    if payload.acao == "corrigir_inventario":
        # Volta para EM_INVENTARIO para corrigir os dados
        db.table("pedidos").update({
            "status": StatusPedido.EM_INVENTARIO.value,
            "atualizado_em": _agora(),
        }).eq("id", str(pedido_id)).execute()
        db.table("movimentacoes").insert({
            "pedido_id": str(pedido_id),
            "status_anterior": StatusPedido.DIVERGENCIA.value,
            "status_novo": StatusPedido.EM_INVENTARIO.value,
            "usuario_id": uid,
            "observacao": f"Divergência tratada — corrigindo inventário: {payload.justificativa}",
            "criado_em": _agora(),
        }).execute()
        return {"ok": True, "proximo": "EM_INVENTARIO", "mensagem": "Inventário reaberto para correção"}
    else:
        # Resolve e avança para processo sistêmico
        db.table("pedidos").update({
            "status": StatusPedido.EM_PROCESSO_SISTEMICO.value,
            "atualizado_em": _agora(),
        }).eq("id", str(pedido_id)).execute()
        db.table("movimentacoes").insert({
            "pedido_id": str(pedido_id),
            "status_anterior": StatusPedido.DIVERGENCIA.value,
            "status_novo": StatusPedido.EM_PROCESSO_SISTEMICO.value,
            "usuario_id": uid,
            "observacao": f"Divergência resolvida: {payload.justificativa}",
            "criado_em": _agora(),
        }).execute()
        return {"ok": True, "proximo": "EM_PROCESSO_SISTEMICO", "mensagem": "Divergência resolvida — prosseguir no D365"}


@router.post("/pedidos/{pedido_id}/inventario/verificar")
def verificar_fisico(
    pedido_id: UUID,
    payload: VerificarFisicoRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.verificar_fisico(str(pedido_id), payload, usuario)


# ── Cubagem ───────────────────────────────────────────────────

@router.post("/pedidos/{pedido_id}/cubagem")
def registrar_cubagem(
    pedido_id: UUID,
    payload: CubagemCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.registrar_cubagem(str(pedido_id), payload, usuario)


@router.get("/pedidos/{pedido_id}/cubagem")
def obter_cubagem(
    pedido_id: UUID,
    _: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.obter_cubagem(str(pedido_id))


# ── Pallets ───────────────────────────────────────────────────

@router.post("/pallets", status_code=201)
def criar_pallet(
    payload: PalletCreate,
    usuario: UsuarioOut = Depends(lider_ou_superior),
):
    return inventario_service.criar_pallet(payload, usuario)


@router.get("/pallets")
def listar_pallets(
    status: Optional[str] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.listar_pallets(status)


@router.get("/relatorio/coletas-realizadas")
def relatorio_coletas_realizadas(
    data_inicio: str = Query(...),
    data_fim: str = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    from app.core.database import get_service_db
    db = get_service_db()

    # Busca pallet_pedidos coletados no período
    registros = db.table("pallet_pedidos").select(
        "*, pedidos(numero_pedido, numero_nf, transportadora_id, transportadoras(nome), clientes(nome)), pallets(codigo, transportadoras(nome))"
    ).eq("status", "COLETADO").gte("coletado_em", f"{data_inicio}T00:00:00").lte("coletado_em", f"{data_fim}T23:59:59").execute().data

    resultado = []
    for r in registros:
        pedido = r.get("pedidos") or {}
        pallet = r.get("pallets") or {}
        # Transportadora real da OV (pode ser diferente do pallet para OUTROS)
        transp_ov = (pedido.get("transportadoras") or {}).get("nome") or "—"
        transp_pallet = (pallet.get("transportadoras") or {}).get("nome") or "—"
        resultado.append({
            "numero_pedido": pedido.get("numero_pedido", "—"),
            "numero_nf": pedido.get("numero_nf"),
            "cliente": (pedido.get("clientes") or {}).get("nome", "—"),
            "transportadora": transp_ov,          # transportadora real da OV
            "pallet": transp_pallet,              # transportadora do pallet
            "pallet_codigo": pallet.get("codigo", "—"),
            "adicionado_em": r.get("adicionado_em"),
            "coletado_em": r.get("coletado_em"),
            "num_caixas": r.get("num_caixas"),
        })

    return resultado


@router.post("/pallets/{pallet_id}/pedidos")
def adicionar_pedido_pallet(
    pallet_id: UUID,
    payload: AdicionarPedidoPalletRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.adicionar_pedido_pallet(str(pallet_id), payload, usuario)


@router.post("/ocorrencias/{ocorrencia_id}/excluir")
def excluir_ocorrencia(ocorrencia_id: str, _: UsuarioOut = Depends(get_current_user)):
    from app.core.database import get_service_db
    db = get_service_db()
    db.table("ocorrencias").delete().eq("id", ocorrencia_id).execute()
    return {"ok": True}


@router.post("/pallets/{pallet_id}/fechar")
def fechar_pallet(
    pallet_id: UUID,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.fechar_pallet(str(pallet_id))


class AlterarTransportadoraRequest(BaseModel):
    transportadora_id: str
    motivo: str


@router.post("/pedidos/{pedido_id}/alterar-transportadora")
def alterar_transportadora(
    pedido_id: UUID,
    payload: AlterarTransportadoraRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    from app.core.database import get_service_db
    from app.services.inventario_service import _agora, _get_usuario_real

    db = get_service_db()
    uid = _get_usuario_real(str(usuario.id))

    # Busca pedido atual
    pedido = db.table("pedidos").select("*, transportadoras(nome)").eq("id", str(pedido_id)).single().execute().data
    if not pedido:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    transp_antiga = (pedido.get("transportadoras") or {}).get("nome", "—")

    # Busca nova transportadora
    nova_transp = db.table("transportadoras").select("id,nome").eq("id", payload.transportadora_id).single().execute().data
    if not nova_transp:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Transportadora não encontrada")

    transp_nova = nova_transp["nome"]

    # Atualiza transportadora no pedido
    db.table("pedidos").update({
        "transportadora_id": payload.transportadora_id,
        "atualizado_em": _agora(),
    }).eq("id", str(pedido_id)).execute()

    # Verifica se OV está em algum pallet e move se necessário
    PALLET_FIXOS = {"BRIX": "PLT-BRIX", "RR CARGO": "PLT-RR CARGO", "CORREIOS": "PLT-CORREIOS"}
    novo_pallet_codigo = PALLET_FIXOS.get(transp_nova.upper(), "PLT-OUTROS")

    pp_atual = db.table("pallet_pedidos").select("id,pallet_id").eq("pedido_id", str(pedido_id)).eq("status", "AGUARDANDO").execute().data
    if pp_atual:
        novo_pallet = db.table("pallets").select("id,codigo").eq("codigo", novo_pallet_codigo).single().execute().data
        if novo_pallet and pp_atual[0]["pallet_id"] != novo_pallet["id"]:
            # Move para o pallet correto
            db.table("pallet_pedidos").update({
                "pallet_id": novo_pallet["id"],
            }).eq("id", pp_atual[0]["id"]).execute()
            pallet_msg = f"OV movida do pallet anterior para {novo_pallet_codigo}."
        else:
            pallet_msg = "Pallet não alterado (mesma categoria)."
    else:
        pallet_msg = "OV não estava em nenhum pallet ativo."

    # Registra ocorrência automática — status ABERTA para ficar visível
    db.table("ocorrencias").insert({
        "pedido_id": str(pedido_id),
        "tipo": "Erro de Transportadora na NF",
        "descricao": (
            f"Transportadora alterada por erro na emissão da NF.\n"
            f"• De: {transp_antiga}\n"
            f"• Para: {transp_nova}\n"
            f"• Motivo: {payload.motivo}\n"
            f"• {pallet_msg}"
        ),
        "responsavel_id": uid,
        "status": "ABERTA",
        "criado_em": _agora(),
    }).execute()

    # Registra movimentação
    db.table("movimentacoes").insert({
        "pedido_id": str(pedido_id),
        "status_anterior": pedido["status"],
        "status_novo": pedido["status"],
        "usuario_id": uid,
        "observacao": f"Transportadora alterada: {transp_antiga} → {transp_nova}. {payload.motivo}",
        "criado_em": _agora(),
    }).execute()

    return {
        "ok": True,
        "transportadora_anterior": transp_antiga,
        "transportadora_nova": transp_nova,
        "pallet": pallet_msg,
    }


class ColetaRequest(BaseModel):
    pedido_ids: Optional[list[str]] = None


@router.post("/pallets/{pallet_id}/coletar")
def confirmar_coleta_pallet(
    pallet_id: UUID,
    payload: ColetaRequest = ColetaRequest(),
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.confirmar_coleta_pallet(str(pallet_id), usuario, payload.pedido_ids)
