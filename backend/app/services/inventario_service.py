"""
Serviços para Inventário Contínuo, Cubagem e Pallets
"""
from datetime import datetime, timezone
from uuid import UUID
import uuid as uuid_module

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.enums import StatusPedido
from app.models.schemas import (
    AdicionarPedidoPalletRequest,
    CubagemCreate,
    InventarioSalvar,
    PalletCreate,
    UsuarioOut,
    VerificarFisicoRequest,
)
from app.services.pedido_service import alterar_status, obter_pedido


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Inventário Contínuo ───────────────────────────────────────────────────────

def _get_usuario_real(usuario_id: str) -> str | None:
    """Retorna o ID real do usuário no banco, ou None se não existir."""
    db = get_service_db()
    result = db.table("usuarios").select("id").eq("id", usuario_id).execute()
    if result.data:
        return usuario_id
    # Fallback: pega o primeiro usuário real
    fallback = db.table("usuarios").select("id").limit(1).execute()
    return fallback.data[0]["id"] if fallback.data else None


def salvar_inventario(pedido_id: str, payload: InventarioSalvar, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    uid = _get_usuario_real(str(usuario.id))

    if pedido["status"] not in (StatusPedido.LIBERADO.value, StatusPedido.EM_INVENTARIO.value,
                                 StatusPedido.AGUARD_TRATATIVA.value):
        raise HTTPException(status_code=422, detail="Pedido não está disponível para inventário")

    # Remove itens anteriores e reinsere
    db.table("inventario_itens").delete().eq("pedido_id", pedido_id).execute()

    itens = [
        {
            "pedido_id": pedido_id,
            "codigo_item": item.codigo_item,
            "lote": item.lote,
            "qtd_sistemico": item.qtd_sistemico,
            "qtd_fisico": item.qtd_fisico,
            "qtd_venda": item.qtd_venda,
            "observacao": item.observacao,
            "operador_id": uid,
            "status_item": "PENDENTE",
            "criado_em": _agora(),
        }
        for item in payload.itens
    ]

    if itens:
        db.table("inventario_itens").insert(itens).execute()

    # Avança status para aguardando verificação
    if pedido["status"] in (StatusPedido.LIBERADO.value, StatusPedido.AGUARD_TRATATIVA.value):
        alterar_status(pedido_id, StatusPedido.EM_INVENTARIO.value, usuario, "Inventário contínuo iniciado")

    alterar_status(pedido_id, StatusPedido.AGUARD_VERIFICACAO.value, usuario, "Inventário salvo — aguardando verificação física")

    return listar_inventario(pedido_id)


def listar_inventario(pedido_id: str) -> dict:
    db = get_service_db()
    itens = db.table("inventario_itens").select("*").eq("pedido_id", pedido_id).execute().data
    return {"pedido_id": pedido_id, "itens": itens, "total_itens": len(itens)}


def verificar_fisico(pedido_id: str, payload: VerificarFisicoRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    uid = _get_usuario_real(str(usuario.id))

    if pedido["status"] != StatusPedido.AGUARD_VERIFICACAO.value:
        raise HTTPException(status_code=422, detail="Pedido não está aguardando verificação física")

    tem_divergencia = False
    for item in payload.itens_verificados:
        update = {
            "qtd_fisico": item.get("qtd_fisico"),
            "status_item": item.get("status_item", "OK"),
            "verificado_por": uid,
        }
        if item.get("observacao"):
            update["observacao"] = item["observacao"]
        if item.get("status_item") == "DIVERGENCIA":
            tem_divergencia = True
        db.table("inventario_itens").update(update).eq("id", item["id"]).execute()

    if tem_divergencia:
        alterar_status(pedido_id, StatusPedido.DIVERGENCIA.value, usuario, "Divergência identificada na verificação física")

        # Cria ocorrência automática com os itens divergentes
        itens_div = db.table("inventario_itens").select("*").eq("pedido_id", pedido_id).eq("status_item", "DIVERGENCIA").execute().data
        descricao_itens = "\n".join([
            f"• Código {i['codigo_item']} / Lote {i['lote']}: Sistema={i['qtd_sistemico']} | Físico={i.get('qtd_fisico','?')} | Venda={i['qtd_venda']} | Estoque={i.get('qtd_estoque','?')}"
            for i in itens_div
        ])
        db.table("ocorrencias").insert({
            "pedido_id": pedido_id,
            "tipo": "Divergência de Estoque",
            "descricao": f"Divergência identificada na verificação física do inventário contínuo:\n{descricao_itens}",
            "responsavel_id": uid,
            "status": "ABERTA",
            "criado_em": _agora(),
        }).execute()
    else:
        alterar_status(pedido_id, StatusPedido.EM_PROCESSO_SISTEMICO.value, usuario, "Verificação física OK — prosseguir no D365")

    return listar_inventario(pedido_id)


# ── Cubagem ───────────────────────────────────────────────────────────────────

def registrar_cubagem(pedido_id: str, payload: CubagemCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    uid = _get_usuario_real(str(usuario.id))

    STATUSES_CUBAGEM = [
        StatusPedido.EM_PROCESSO_SISTEMICO.value,
        StatusPedido.AGUARD_FATURAMENTO.value,
        StatusPedido.FATURADO.value,
        StatusPedido.AGUARD_COLETA.value,
    ]
    if pedido["status"] not in STATUSES_CUBAGEM:
        raise HTTPException(status_code=422, detail="Cubagem só pode ser registrada após o processo sistêmico")

    # Remove cubagem anterior se houver
    db.table("cubagem").delete().eq("pedido_id", pedido_id).execute()

    cub = {
        "pedido_id": pedido_id,
        "peso_kg": payload.peso_kg,
        "altura_cm": payload.altura_cm,
        "largura_cm": payload.largura_cm,
        "comprimento_cm": payload.comprimento_cm,
        "num_caixas": payload.num_caixas,
        "observacao": payload.observacao,
        "registrado_por": uid,
        "criado_em": _agora(),
    }
    result = db.table("cubagem").insert(cub).execute().data[0]

    # Salva e monta itens de cubagem (tipos de caixa)
    db.table("cubagem_itens").delete().eq("pedido_id", pedido_id).execute()
    itens_para_msg = []
    for item in payload.itens:
        if not item.tipo_caixa_nome:
            continue
        db.table("cubagem_itens").insert({
            "pedido_id": pedido_id,
            "tipo_caixa_id": item.tipo_caixa_id or None,
            "tipo_caixa_nome": item.tipo_caixa_nome,
            "quantidade": item.quantidade,
            "criado_em": _agora(),
        }).execute()
        desc = ""
        if item.tipo_caixa_id:
            tc = db.table("tipos_caixa").select("descricao").eq("id", item.tipo_caixa_id).execute()
            if tc.data:
                desc = tc.data[0].get("descricao", "")
        itens_para_msg.append({
            "tipo_caixa_nome": item.tipo_caixa_nome,
            "quantidade": item.quantidade,
            "tipos_caixa": {"descricao": desc},
        })

    # Só avança o status se ainda estiver em processo sistêmico
    if pedido["status"] == StatusPedido.EM_PROCESSO_SISTEMICO.value:
        alterar_status(pedido_id, StatusPedido.AGUARD_FATURAMENTO.value, usuario, "Cubagem registrada — aguardando faturamento")

    # Monta mensagem para o Teams
    cliente_nome = (pedido.get("cliente") or pedido.get("clientes") or {}).get("nome", "")
    msg = gerar_mensagem_teams(pedido["numero_pedido"], cliente_nome, result, itens_para_msg)
    return {"cubagem": result, "mensagem_teams": msg}


def obter_cubagem(pedido_id: str) -> dict | None:
    db = get_service_db()
    result = db.table("cubagem").select("*").eq("pedido_id", pedido_id).execute()
    return result.data[0] if result.data else None


def gerar_mensagem_teams(numero_pedido: str, cliente: str, cubagem: dict, itens: list = None) -> str:
    linhas = [f"📦 *Cubagem — {numero_pedido}*"]

    if cliente:
        linhas.append(f"👤 Cliente: {cliente}")

    linhas.append("")

    # Tipos de caixa com quantidade e dimensões
    if itens:
        linhas.append("📦 *Caixas:*")
        for item in itens:
            nome = item.get("tipo_caixa_nome") or "—"
            qtd = item.get("quantidade", 1)
            # Busca dimensões do tipo de caixa
            tipo = item.get("tipos_caixa") or {}
            desc = tipo.get("descricao", "")
            if desc:
                linhas.append(f"  • {qtd}x {nome} — {desc}")
            else:
                linhas.append(f"  • {qtd}x {nome}")

    linhas.append("")

    if cubagem.get("num_caixas"):
        linhas.append(f"📊 Total: {cubagem['num_caixas']} caixa(s)")
    if cubagem.get("peso_kg"):
        linhas.append(f"⚖️ Peso total: {cubagem['peso_kg']} kg")
    if cubagem.get("observacao"):
        linhas.append(f"📝 Obs: {cubagem['observacao']}")

    linhas.append("")
    linhas.append("✅ Pronto para faturamento")
    return "\n".join(linhas)


# ── Pallets ───────────────────────────────────────────────────────────────────

def fechar_pallet(pallet_id: str) -> dict:
    db = get_service_db()
    result = db.table("pallets").update({"status": "FECHADO"}).eq("id", pallet_id).execute()
    return {"ok": True, "pallet_id": pallet_id}


def criar_pallet(payload: PalletCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Gera código sequencial
    existentes = db.table("pallets").select("codigo").execute().data
    num = len(existentes) + 1
    codigo = f"PLT-{str(num).zfill(4)}"

    pallet = {
        "codigo": codigo,
        "transportadora_id": str(payload.transportadora_id),
        "status": "ABERTO",
        "data_prevista_coleta": payload.data_prevista_coleta.isoformat() if payload.data_prevista_coleta else None,
        "observacao": payload.observacao,
        "criado_em": _agora(),
    }
    result = db.table("pallets").insert(pallet).execute().data[0]
    return result


def listar_pallets(status: str | None = None) -> list:
    db = get_service_db()
    query = db.table("pallets").select("*, transportadoras(id, nome)")
    if status:
        query = query.eq("status", status)
    pallets = query.order("criado_em", desc=True).execute().data

    for p in pallets:
        pedidos = db.table("pallet_pedidos").select(
            "*, pedidos(numero_pedido, numero_nf, status, transportadora_id, transportadoras(nome), clientes(nome))"
        ).eq("pallet_id", p["id"]).eq("status", "AGUARDANDO").execute().data
        # Adiciona transportadora_nome direto no pedido para facilitar frontend
        for pp in pedidos:
            if pp.get("pedidos") and pp["pedidos"].get("transportadoras"):
                pp["pedidos"]["transportadora_nome"] = pp["pedidos"]["transportadoras"].get("nome")
        p["pedidos"] = pedidos
        p["total_caixas"] = sum(pp.get("num_caixas") or 0 for pp in pedidos)
        p["transportadora_nome"] = p.get("transportadoras", {}).get("nome") if p.get("transportadoras") else None

    return pallets


def adicionar_pedido_pallet(pallet_id: str, payload: AdicionarPedidoPalletRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Busca por número de OV (ex: OV015374) ou por UUID
    pedido_id_str = str(payload.pedido_id)
    pedido = None

    # Tenta buscar pelo número do pedido primeiro
    por_numero = db.table("pedidos").select("*").eq("numero_pedido", pedido_id_str.upper()).execute()
    if por_numero.data:
        pedido = por_numero.data[0]
    else:
        # Tenta por UUID
        try:
            por_id = db.table("pedidos").select("*").eq("id", pedido_id_str).execute()
            if por_id.data:
                pedido = por_id.data[0]
        except Exception:
            pass

    if not pedido:
        raise HTTPException(status_code=404, detail=f"Pedido '{pedido_id_str}' não encontrado")

    if pedido["status"] != StatusPedido.FATURADO.value:
        raise HTTPException(
            status_code=422,
            detail=f"Pedido '{pedido['numero_pedido']}' precisa estar FATURADO (status atual: {pedido['status']})"
        )

    # Verifica se já está em algum pallet
    existente = db.table("pallet_pedidos").select("id").eq("pedido_id", pedido["id"]).execute()
    if existente.data:
        raise HTTPException(status_code=400, detail="Pedido já está em um pallet")

    db.table("pallet_pedidos").insert({
        "pallet_id": pallet_id,
        "pedido_id": pedido["id"],
        "num_caixas": payload.num_caixas,
        "adicionado_em": _agora(),
    }).execute()

    # Atualiza status do pedido para AGUARD_COLETA diretamente no banco
    db.table("pedidos").update({
        "status": StatusPedido.AGUARD_COLETA.value,
        "atualizado_em": _agora(),
    }).eq("id", pedido["id"]).execute()

    return {"ok": True, "pallet_id": pallet_id, "pedido": pedido["numero_pedido"]}


def confirmar_coleta_pallet(pallet_id: str, usuario: UsuarioOut, pedido_ids: list[str] | None = None) -> dict:
    """
    Confirma coleta de OVs específicas (ou todas se pedido_ids for None).
    As OVs coletadas são expedidas. O pallet só fecha se todas forem coletadas.
    """
    db = get_service_db()

    # Busca todos os pedidos do pallet
    todos = db.table("pallet_pedidos").select("id,pedido_id").eq("pallet_id", pallet_id).execute().data

    # Se não especificou quais, coleta todas
    if not pedido_ids:
        a_coletar = todos
    else:
        a_coletar = [pp for pp in todos if pp["id"] in pedido_ids]

    agora = _agora()
    expedidos = 0
    for pp in a_coletar:
        try:
            db.table("pedidos").update({
                "status": StatusPedido.EXPEDIDO.value,
                "atualizado_em": agora,
            }).eq("id", pp["pedido_id"]).execute()
            # Marca como coletado (não deleta — mantém histórico)
            db.table("pallet_pedidos").update({
                "coletado_em": agora,
                "status": "COLETADO",
            }).eq("id", pp["id"]).execute()
            expedidos += 1
        except Exception:
            pass

    # Verifica se ainda há OVs aguardando no pallet
    PALLETS_FIXOS = ['PLT-BRIX', 'PLT-RR CARGO', 'PLT-CORREIOS', 'PLT-OUTROS']
    restantes = db.table("pallet_pedidos").select("id").eq("pallet_id", pallet_id).eq("status", "AGUARDANDO").execute().data
    if not restantes:
        # Pallets fixos voltam para ABERTO (nunca fecham permanentemente)
        pallet_info = db.table("pallets").select("codigo").eq("id", pallet_id).execute().data
        codigo = pallet_info[0]["codigo"] if pallet_info else ""
        if codigo in PALLETS_FIXOS:
            db.table("pallets").update({"status": "ABERTO"}).eq("id", pallet_id).execute()
        else:
            db.table("pallets").update({
                "status": "COLETADO",
                "data_real_coleta": agora,
            }).eq("id", pallet_id).execute()

    return {"ok": True, "pallet_id": pallet_id, "pedidos_expedidos": expedidos}
