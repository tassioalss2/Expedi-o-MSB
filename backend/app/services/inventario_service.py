"""
Serviços para Inventário Contínuo, Cubagem e Pallets
"""
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID
import uuid as uuid_module

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.enums import StatusPedido, TipoFrete
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

    # Regra de negócio: a quantidade de venda nunca pode ser zero.
    for item in payload.itens:
        if not item.qtd_venda or item.qtd_venda <= 0:
            raise HTTPException(
                status_code=422,
                detail=f"Quantidade de venda deve ser maior que zero (item {item.codigo_item or '—'}).",
            )

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


def ultimo_inventario_lote(codigo: str, lote: str) -> Optional[dict]:
    """Último inventário registrado para um (código, lote).

    Retorna o estoque que sobrou (base − venda) para pré-preencher a Qtd Sistema
    do próximo inventário do mesmo lote (inventário contínuo).
    """
    codigo = (codigo or "").strip()
    lote = (lote or "").strip()
    if not codigo or not lote:
        return None

    db = get_service_db()
    rows = db.table("inventario_itens").select("*")\
        .eq("codigo_item", codigo).eq("lote", lote)\
        .order("criado_em", desc=True).limit(1).execute().data
    if not rows:
        return None

    it = rows[0]
    sistemico = float(it.get("qtd_sistemico") or 0)
    fisico = it.get("qtd_fisico")
    fisico = float(fisico) if fisico is not None else None
    venda = float(it.get("qtd_venda") or 0)
    base = fisico if fisico is not None else sistemico
    return {
        "codigo_item": codigo,
        "lote": lote,
        "qtd_sistemico": round(sistemico),
        "qtd_fisico": round(fisico) if fisico is not None else None,
        "qtd_venda": round(venda),
        "estoque": round(base - venda),
        "criado_em": it.get("criado_em"),
    }


def listar_inventario(pedido_id: str) -> dict:
    db = get_service_db()
    itens = db.table("inventario_itens").select("*").eq("pedido_id", pedido_id).execute().data

    # Puxa a última validade já registrada para cada (código, lote) — vinda das
    # etiquetas impressas em inventários anteriores (fila_impressao). Assim, se o
    # lote já foi inventariado, a validade vem preenchida automaticamente.
    lotes = {(i.get("lote") or "").strip() for i in itens if i.get("lote")}
    if lotes:
        fila = db.table("fila_impressao").select("payload").order("criado_em", desc=True).execute().data
        conhecida: dict[tuple, str] = {}
        for row in fila:
            p = row.get("payload") or {}
            val = p.get("validade")
            lote = (p.get("lote") or "").strip()
            cod = (p.get("codigo") or "").strip()
            if not val or lote not in lotes:
                continue
            chave = (cod, lote)
            if chave not in conhecida:  # fila vem em ordem decrescente → 1ª = mais recente
                conhecida[chave] = val
        for i in itens:
            i["validade_conhecida"] = conhecida.get(
                ((i.get("codigo_item") or "").strip(), (i.get("lote") or "").strip())
            )

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
        StatusPedido.EM_COTACAO_FRETE.value,
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

    # Só avança o status se ainda estiver em processo sistêmico.
    # CIF (com/sem valor) precisa cotar o frete antes de faturar; FOB vai direto.
    if pedido["status"] == StatusPedido.EM_PROCESSO_SISTEMICO.value:
        eh_cif = (pedido.get("tipo_frete") or "FOB") in (
            TipoFrete.CIF_COM_VALOR.value, TipoFrete.CIF_SEM_VALOR.value,
        )
        if eh_cif:
            alterar_status(pedido_id, StatusPedido.EM_COTACAO_FRETE.value, usuario,
                           "Cubagem registrada — CIF: aguardando cotação de frete")
        else:
            alterar_status(pedido_id, StatusPedido.AGUARD_FATURAMENTO.value, usuario,
                           "Cubagem registrada — FOB: aguardando faturamento")

    # Alimenta o inventário contínuo automaticamente (falha silenciosa para não bloquear)
    try:
        _registrar_contagens_automaticas(pedido_id, pedido["numero_pedido"], uid, usuario.nome)
    except Exception:
        pass

    # Monta mensagem para o Teams
    cliente_nome = (pedido.get("cliente") or pedido.get("clientes") or {}).get("nome", "")
    msg = gerar_mensagem_teams(pedido["numero_pedido"], cliente_nome, result, itens_para_msg)
    return {"cubagem": result, "mensagem_teams": msg}


def _registrar_contagens_automaticas(pedido_id: str, pedido_numero: str, uid: str, operador_nome: str) -> None:
    """Cria contagens no inventário contínuo para os itens verificados do pedido.
    Só age se houver um ciclo aberto. Falhas não bloqueiam o fluxo principal.
    """
    db = get_service_db()

    ciclo_res = db.table("inventario_ciclos").select("id").eq("status", "ABERTO").execute()
    if not ciclo_res.data:
        return

    ciclo_id = ciclo_res.data[0]["id"]

    itens = db.table("inventario_itens").select("*").eq("pedido_id", pedido_id).execute().data
    if not itens:
        return

    # Motivo padrão para divergências geradas automaticamente
    motivo_res = db.table("inventario_motivos").select("id").ilike("descricao", "%venda%").limit(1).execute()
    if not motivo_res.data:
        motivo_res = db.table("inventario_motivos").select("id").eq("ativo", True).limit(1).execute()
    motivo_padrao_id = motivo_res.data[0]["id"] if motivo_res.data else None

    agora = _agora()
    for item in itens:
        qtd_sist  = int(item.get("qtd_sistemico") or 0)
        qtd_fis   = int(item.get("qtd_fisico") if item.get("qtd_fisico") is not None else qtd_sist)
        qtd_venda = int(item.get("qtd_venda") or 0)

        divergencia = qtd_fis - qtd_sist
        pct = round(abs(divergencia) / qtd_sist * 100, 2) if qtd_sist > 0 else 0.0
        status = "OK" if divergencia == 0 else "EM_ANALISE"

        db.table("inventario_contagens").insert({
            "ciclo_id":          ciclo_id,
            "codigo_produto":    item["codigo_item"],
            "descricao_produto": None,
            "lote":              item["lote"],
            "operador_id":       uid,
            "operador_nome":     operador_nome,
            "qtd_sistemica":     qtd_sist,
            "qtd_fisica":        qtd_fis,
            "qtd_venda":         qtd_venda,
            "qtd_divergencia":   divergencia,
            "pct_divergencia":   pct,
            "status":            status,
            "motivo_id":         motivo_padrao_id if divergencia != 0 else None,
            "observacao":        f"Registrado automaticamente via OV {pedido_numero}",
            "contado_em":        agora,
            "criado_em":         agora,
            "atualizado_em":     agora,
        }).execute()


def obter_cubagem(pedido_id: str) -> dict | None:
    db = get_service_db()
    result = db.table("cubagem").select("*").eq("pedido_id", pedido_id).execute()
    if not result.data:
        return None
    cub = result.data[0]

    # Busca itens de cubagem com dimensões do tipo de caixa
    itens_res = db.table("cubagem_itens").select("*, tipos_caixa(descricao)").eq("pedido_id", pedido_id).execute()
    itens = itens_res.data or []

    # Busca nome do cliente para montar a mensagem
    pedido_res = db.table("pedidos").select("numero_pedido, clientes(nome)").eq("id", pedido_id).execute()
    if pedido_res.data:
        p = pedido_res.data[0]
        numero = p.get("numero_pedido", "")
        cliente_nome = (p.get("clientes") or {}).get("nome", "")
    else:
        numero = ""
        cliente_nome = ""

    cub["mensagem_teams"] = gerar_mensagem_teams(numero, cliente_nome, cub, itens)
    return cub


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


FIXO_CARRIER_MAP = {
    'BRIX': 'PLT-BRIX',
    'RR CARGO': 'PLT-RR CARGO',
    'CORREIOS': 'PLT-CORREIOS',
}


def _resolver_pallet_por_carrier(db, carrier: str) -> str | None:
    """Retorna o pallet_id correto para um nome de transportadora.
    Pallets fixos conhecidos → usa o fixo. Outros → cria/reutiliza temp."""
    upper = carrier.upper()
    if upper in FIXO_CARRIER_MAP:
        row = db.table("pallets").select("id").eq("codigo", FIXO_CARRIER_MAP[upper]).execute().data
        return row[0]["id"] if row else None
    return _obter_ou_criar_pallet_temp(db, carrier)


def _migrar_outros_para_temp(db) -> None:
    """Move todas as OVs em PLT-OUTROS para o pallet correto de cada transportadora.
    Cobre dois casos: [Transp. real: X] em observacoes OU transportadora_nome direto."""
    import re
    plt_outros = db.table("pallets").select("id").eq("codigo", "PLT-OUTROS").execute().data
    if not plt_outros:
        return
    plt_outros_id = plt_outros[0]["id"]
    pps = db.table("pallet_pedidos").select(
        "id, pedidos(observacoes, transportadoras(nome))"
    ).eq("pallet_id", plt_outros_id).eq("status", "AGUARDANDO").execute().data
    for pp in (pps or []):
        ped = pp.get("pedidos") or {}
        obs = ped.get("observacoes") or ""
        transp_nome = ((ped.get("transportadoras") or {}).get("nome") or "")
        # Prioridade 1: [Transp. real: X] em observacoes
        m = re.search(r'\[Transp\. real: ([^\]]+)\]', obs)
        carrier = m.group(1).strip() if m else None
        # Prioridade 2: nome direto da transportadora (ex: "RR CARGO" linkado diretamente)
        if not carrier and transp_nome and transp_nome.upper() != 'OUTROS':
            carrier = transp_nome
        if carrier:
            target_id = _resolver_pallet_por_carrier(db, carrier)
            if target_id:
                db.table("pallet_pedidos").update({"pallet_id": target_id}).eq("id", pp["id"]).execute()


def listar_pallets(status: str | None = None) -> list:
    db = get_service_db()

    # Migra OVs legadas em PLT-OUTROS para seus pallets temporários
    _migrar_outros_para_temp(db)

    query = db.table("pallets").select("*, transportadoras(id, nome)")
    if status:
        query = query.eq("status", status)
    pallets = query.order("criado_em", desc=True).execute().data

    for p in pallets:
        pedidos = db.table("pallet_pedidos").select(
            "*, pedidos(numero_pedido, numero_nf, status, observacoes, transportadora_id, transportadoras(nome), clientes(nome))"
        ).eq("pallet_id", p["id"]).eq("status", "AGUARDANDO").execute().data
        for pp in pedidos:
            if pp.get("pedidos") and pp["pedidos"].get("transportadoras"):
                pp["pedidos"]["transportadora_nome"] = pp["pedidos"]["transportadoras"].get("nome")
        p["pedidos"] = pedidos
        p["total_caixas"] = sum(pp.get("num_caixas") or 0 for pp in pedidos)
        p["transportadora_nome"] = p.get("transportadoras", {}).get("nome") if p.get("transportadoras") else None
        if not p["transportadora_nome"] and p.get("observacao"):
            p["transportadora_nome"] = p["observacao"]
            p["pallet_temp"] = True

    return pallets


def _extrair_transportadora_real(observacoes: str | None) -> str | None:
    """Extrai o nome da transportadora real do campo observacoes (padrão [Transp. real: X])."""
    import re
    if not observacoes:
        return None
    m = re.search(r'\[Transp\. real: ([^\]]+)\]', observacoes)
    return m.group(1).strip() if m else None


def _obter_ou_criar_pallet_temp(db, nome_transportadora: str) -> str:
    """Retorna o id de um pallet temporário ativo para esta transportadora, criando um se necessário."""
    existentes = db.table("pallets").select("id, status")\
        .eq("observacao", nome_transportadora).execute().data
    ativo = next((p for p in (existentes or [])
                  if p.get("status") not in ("COLETADO", "FECHADO", "CANCELADO")), None)
    if ativo:
        return ativo["id"]
    # Cria novo pallet temporário com código sequencial
    todos = db.table("pallets").select("codigo").execute().data
    num = len(todos) + 1
    codigo = f"PLT-{str(num).zfill(4)}"
    novo = db.table("pallets").insert({
        "codigo": codigo,
        "status": "ABERTO",
        "observacao": nome_transportadora,
        "criado_em": _agora(),
    }).execute().data[0]
    return novo["id"]


def adicionar_pedido_pallet(pallet_id: str, payload: AdicionarPedidoPalletRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Busca por UUID (remessa específica) ou por número de OV (ex: OV015374)
    pedido_id_str = str(payload.pedido_id)
    pedido = None
    parece_uuid = len(pedido_id_str) == 36 and pedido_id_str.count("-") == 4

    if parece_uuid:
        # UUID identifica a remessa exata — evita pegar outra remessa da família
        try:
            por_id = db.table("pedidos").select("*").eq("id", pedido_id_str).execute()
            if por_id.data:
                pedido = por_id.data[0]
        except Exception:
            pass

    if not pedido:
        por_numero = db.table("pedidos").select("*").eq("numero_pedido", pedido_id_str.upper()).execute()
        if por_numero.data:
            # Família (R1/R2...): mesma OV em várias remessas. Prioriza a que está
            # FATURADA (pronta p/ pallet) em vez de pegar uma já expedida.
            faturadas = [p for p in por_numero.data if p["status"] == StatusPedido.FATURADO.value]
            pedido = faturadas[0] if faturadas else por_numero.data[0]

    if not pedido:
        raise HTTPException(status_code=404, detail=f"Pedido '{pedido_id_str}' não encontrado")

    if pedido["status"] != StatusPedido.FATURADO.value:
        raise HTTPException(
            status_code=422,
            detail=f"Pedido '{pedido['numero_pedido']}' precisa estar FATURADO (status atual: {pedido['status']})"
        )

    # Redireciona para o pallet correto conforme transportadora da OV
    transp_real = _extrair_transportadora_real(pedido.get("observacoes"))
    if not transp_real and pedido.get("transportadora_id"):
        t = db.table("transportadoras").select("nome").eq("id", pedido["transportadora_id"]).execute().data
        if t:
            nome_t = (t[0].get("nome") or "").upper()
            if nome_t and nome_t != "OUTROS":
                transp_real = t[0].get("nome")
    if transp_real:
        target_id = _resolver_pallet_por_carrier(db, transp_real)
        if target_id:
            pallet_id = target_id

    # Verifica se já está em algum pallet ATIVO (ignora pallets já coletados/cancelados)
    existente = db.table("pallet_pedidos").select("id, pallet_id").eq("pedido_id", pedido["id"]).execute()
    if existente.data:
        pallet_id_atual = existente.data[0]["pallet_id"]
        pallet_atual = db.table("pallets").select("status").eq("id", pallet_id_atual).execute()
        status_pallet = pallet_atual.data[0]["status"] if pallet_atual.data else None
        if status_pallet not in ("realizado", "cancelado", None):
            raise HTTPException(status_code=400, detail="Pedido já está em um pallet")

    # Auto-preenche num_caixas da cubagem se não informado
    num_caixas = payload.num_caixas
    if num_caixas is None:
        cub = db.table("cubagem").select("num_caixas").eq("pedido_id", pedido["id"]).execute()
        if cub.data:
            num_caixas = cub.data[0].get("num_caixas")

    insert_data: dict = {
        "pallet_id": pallet_id,
        "pedido_id": pedido["id"],
        "num_caixas": num_caixas,
        "adicionado_em": _agora(),
    }
    if payload.observacao:
        insert_data["observacao"] = payload.observacao
    db.table("pallet_pedidos").insert(insert_data).execute()

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
    uid = _get_usuario_real(str(usuario.id))
    expedidos = 0
    for pp in a_coletar:
        try:
            db.table("pedidos").update({
                "status": StatusPedido.EXPEDIDO.value,
                "atualizado_em": agora,
            }).eq("id", pp["pedido_id"]).execute()
            # Registra a movimentação para EXPEDIDO (alimenta a linha do tempo da OV)
            db.table("movimentacoes").insert({
                "pedido_id":       pp["pedido_id"],
                "status_anterior": StatusPedido.AGUARD_COLETA.value,
                "status_novo":     StatusPedido.EXPEDIDO.value,
                "usuario_id":      uid,
                "observacao":      "Coleta confirmada — OV expedida",
                "criado_em":       agora,
            }).execute()
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
