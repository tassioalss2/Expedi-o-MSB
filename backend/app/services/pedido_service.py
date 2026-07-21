from datetime import date, datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status

from app.core.database import get_service_db
from app.models.enums import (
    DecisaoTratativa,
    Prioridade,
    ResultadoConferencia,
    StatusPedido,
    TRANSICOES_PERMITIDAS,
)
from app.models.schemas import (
    AgendarColetaRequest,
    ConfirmarColetaRequest,
    CotacaoFreteRequest,
    FaturamentoRequest,
    FinalizarConferenciaRequest,
    FinalizarSeparacaoRequest,
    OcorrenciaCreate,
    PedidoCreate,
    TratativaRequest,
    UsuarioOut,
)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _enviar_teams(texto: str) -> None:
    """Envia uma mensagem ao canal Teams da expedição (silencioso se não houver webhook)."""
    from app.core.config import settings
    webhook = settings.teams_webhook_expedicao
    if not webhook:
        return
    import requests as _req
    try:
        _req.post(webhook, json={"text": texto}, timeout=5)
    except Exception:
        pass


def _notificar_teams_nova_ov(pedido: dict, cliente_nome: str) -> None:
    """Envia notificação ao canal Teams da expedição quando uma nova OV é criada."""
    from app.core.config import settings
    webhook = settings.teams_webhook_expedicao
    if not webhook:
        return

    PRIORIDADE_LABEL = {"NORMAL": "Normal", "ALTA": "⚡ Alta", "CRITICA": "🔴 Crítica"}
    FRETE_LABEL = {"FOB": "FOB", "CIF_COM_VALOR": "CIF com Valor NF", "CIF_SEM_VALOR": "CIF sem Valor NF"}

    data_entrega = pedido.get("data_prevista_entrega", "")
    try:
        from datetime import date as _date
        data_entrega = _date.fromisoformat(data_entrega).strftime("%d/%m/%Y")
    except Exception:
        pass

    texto = (
        f"📋 **Nova OV recebida — {pedido['numero_pedido']}**\n\n"
        f"👤 Cliente: **{cliente_nome}**\n"
        f"🚚 Frete: {FRETE_LABEL.get(pedido.get('tipo_frete', 'FOB'), pedido.get('tipo_frete', ''))}\n"
        f"📅 Entrega prevista: **{data_entrega}**\n"
        f"⚑ Prioridade: {PRIORIDADE_LABEL.get(pedido.get('prioridade', 'NORMAL'), 'Normal')}"
    )

    import requests as _req
    try:
        _req.post(webhook, json={"text": texto}, timeout=5)
    except Exception:
        pass


def _validar_transicao(atual: str, novo: str) -> None:
    permitidos = TRANSICOES_PERMITIDAS.get(StatusPedido(atual), [])
    if StatusPedido(novo) not in permitidos:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Transição '{atual}' → '{novo}' não é permitida",
        )


def _registrar_movimentacao(pedido_id: str, status_anterior: str, status_novo: str,
                             usuario_id: str, observacao: Optional[str] = None) -> None:
    db = get_service_db()
    # Busca o primeiro usuário real do banco para usar como referência
    usuarios = db.table("usuarios").select("id").limit(1).execute()
    uid = usuarios.data[0]["id"] if usuarios.data else None
    db.table("movimentacoes").insert({
        "pedido_id": pedido_id,
        "status_anterior": status_anterior,
        "status_novo": status_novo,
        "usuario_id": uid,
        "observacao": observacao,
        "criado_em": _agora(),
    }).execute()


_STATUSES_PERMITE_DERIVAR = {"FATURADO", "AGUARD_COLETA", "EXPEDIDO"}


def criar_pedido(payload: PedidoCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # ── Verifica duplicidade ───────────────────────────────────────────────────
    # Busca todas as OVs com esse número; usa a original (menor remessa_numero)
    existe = (
        db.table("pedidos")
        .select("id,status,remessa_numero")
        .eq("numero_pedido", payload.numero_pedido)
        .execute()
    )
    if existe.data:
        ped_existente = sorted(existe.data, key=lambda x: x.get("remessa_numero") or 1)[0]
        pode_derivar = ped_existente["status"] in _STATUSES_PERMITE_DERIVAR

        if not payload.forcar_duplicata and not payload.criar_derivada:
            # Calcula qual seria o próximo número de remessa
            todas = db.table("pedidos").select("remessa_numero").eq("numero_pedido", payload.numero_pedido).execute()
            max_remessa = max((r.get("remessa_numero") or 1) for r in todas.data)
            raise HTTPException(
                status_code=409,
                detail={
                    "msg": f"Pedido '{payload.numero_pedido}' já existe.",
                    "status_existente": ped_existente["status"],
                    "pode_recriar": ped_existente["status"] == "CANCELADO",
                    "pode_derivar": pode_derivar,
                    "pedido_pai_id": ped_existente["id"],
                    "remessa_numero_proximo": max_remessa + 1,
                },
            )

        # criar_derivada=True → nova OV vinculada à original
        if payload.criar_derivada:
            if not pode_derivar:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"OV '{payload.numero_pedido}' está com status '{ped_existente['status']}'. "
                        "Só é possível criar remessa derivada de OVs já faturadas ou expedidas."
                    ),
                )
            todas = db.table("pedidos").select("remessa_numero").eq("numero_pedido", payload.numero_pedido).execute()
            max_remessa = max((r.get("remessa_numero") or 1) for r in todas.data)
            nova_remessa = max_remessa + 1

            from app.services.inventario_service import _get_usuario_real
            uid = _get_usuario_real(str(usuario.id))
            pedido_data = {
                "numero_pedido":         payload.numero_pedido,
                "cliente_id":            str(payload.cliente_id),
                "transportadora_id":     str(payload.transportadora_id) if payload.transportadora_id else None,
                "tipo_frete":            payload.tipo_frete.value if payload.tipo_frete else "FOB",
                "tipo_operacao":         payload.tipo_operacao.value if payload.tipo_operacao else "VENDA_NORMAL",
                "canal":                 payload.canal.value if payload.canal else None,
                "local_entrega":         payload.local_entrega,
                "status":                StatusPedido.LIBERADO.value,
                "prioridade":            payload.prioridade.value,
                "data_prevista_entrega": payload.data_prevista_entrega.isoformat(),
                "data_prevista_coleta":  payload.data_prevista_coleta.isoformat() if payload.data_prevista_coleta else None,
                "observacoes":           payload.observacoes,
                "pedido_pai_id":         ped_existente["id"],
                "remessa_numero":        nova_remessa,
                "criado_por":            None,
                "criado_em":             _agora(),
                "atualizado_em":         _agora(),
            }
            try:
                resultado = db.table("pedidos").insert(pedido_data).execute()
            except Exception as exc:
                import requests as _req
                msg = str(exc)
                if isinstance(exc, _req.HTTPError) and exc.response is not None:
                    try:
                        msg = exc.response.json().get("message") or exc.response.text or msg
                    except Exception:
                        msg = exc.response.text or msg
                raise HTTPException(status_code=500, detail=f"Erro ao criar remessa no banco: {msg}")
            pedido = resultado.data[0]
            itens = [
                {
                    "pedido_id":       pedido["id"],
                    "produto_id":      str(item.produto_id),
                    "lote_id":         str(item.lote_id) if item.lote_id else None,
                    "qtd_solicitada":  item.qtd_solicitada,
                    "valor_unitario":  item.valor_unitario,
                    "status_item":     "PENDENTE",
                }
                for item in payload.itens
            ]
            if itens:
                db.table("itens_pedido").insert(itens).execute()
            _registrar_movimentacao(pedido["id"], None, StatusPedido.LIBERADO.value, uid,
                                    f"Remessa R{nova_remessa} criada a partir da OV original {payload.numero_pedido}")
            return pedido

        # forcar_duplicata=True: só permite recriar OVs CANCELADAS
        if ped_existente["status"] != "CANCELADO":
            raise HTTPException(
                status_code=400,
                detail=(
                    f"OV '{payload.numero_pedido}' já existe com status "
                    f"'{ped_existente['status']}'. Só é possível recriar OVs canceladas."
                ),
            )

        # ── Reativa a OV cancelada com os novos dados do formulário ───────────
        from app.services.inventario_service import _get_usuario_real
        uid   = _get_usuario_real(str(usuario.id))
        agora = _agora()
        pid   = ped_existente["id"]

        db.table("pedidos").update({
            "status":                StatusPedido.LIBERADO.value,
            "cliente_id":            str(payload.cliente_id),
            "transportadora_id":     str(payload.transportadora_id) if payload.transportadora_id else None,
            "tipo_frete":            payload.tipo_frete.value if payload.tipo_frete else "FOB",
            "tipo_operacao":         payload.tipo_operacao.value if payload.tipo_operacao else "VENDA_NORMAL",
            "canal":                 payload.canal.value if payload.canal else None,
            "local_entrega":         payload.local_entrega,
            "prioridade":            payload.prioridade.value,
            "data_prevista_entrega": payload.data_prevista_entrega.isoformat(),
            "data_prevista_coleta":  payload.data_prevista_coleta.isoformat() if payload.data_prevista_coleta else None,
            "observacoes":           payload.observacoes,
            "numero_nf":             None,   # limpa dados do ciclo anterior
            "valor_nf":              None,
            "atualizado_em":         agora,
        }).eq("id", pid).execute()

        # Registra ocorrência auditável
        db.table("ocorrencias").insert({
            "pedido_id":      pid,
            "tipo":           "OV Recriada após Cancelamento",
            "descricao": (
                f"OV {payload.numero_pedido} foi recriada após cancelamento.\n"
                f"Motivo informado: {payload.motivo_duplicata}\n"
                f"Operador confirmou que a recriação é intencional."
            ),
            "responsavel_id": uid,
            "status":         "FECHADA",
            "resolucao":      payload.motivo_duplicata,
            "resolvido_por":  uid,
            "resolvido_em":   agora,
            "criado_em":      agora,
        }).execute()

        _registrar_movimentacao(
            pid, "CANCELADO", StatusPedido.LIBERADO.value,
            uid, f"OV recriada após cancelamento. Motivo: {payload.motivo_duplicata}"
        )

        return db.table("pedidos").select("*").eq("id", pid).execute().data[0]

    # ── Criação normal ─────────────────────────────────────────────────────────
    status_inicial = (
        StatusPedido.AGUARD_CREDITO.value
        if payload.em_gerenciamento_credito
        else StatusPedido.LIBERADO.value
    )
    pedido_data = {
        "numero_pedido": payload.numero_pedido,
        "cliente_id": str(payload.cliente_id),
        "transportadora_id": str(payload.transportadora_id) if payload.transportadora_id else None,
        "tipo_frete": payload.tipo_frete.value if payload.tipo_frete else "FOB",
        "tipo_operacao": payload.tipo_operacao.value if payload.tipo_operacao else "VENDA_NORMAL",
        "canal": payload.canal.value if payload.canal else None,
        "local_entrega": payload.local_entrega,
        "status": status_inicial,
        "prioridade": payload.prioridade.value,
        "data_prevista_entrega": payload.data_prevista_entrega.isoformat(),
        "data_prevista_coleta": payload.data_prevista_coleta.isoformat() if payload.data_prevista_coleta else None,
        "observacoes": payload.observacoes,
        "criado_por": None,
        "criado_em": _agora(),
        "atualizado_em": _agora(),
    }
    if getattr(payload, "empenho_id", None):
        pedido_data["empenho_id"] = str(payload.empenho_id)
    if getattr(payload, "valor_frete", None) is not None:
        pedido_data["valor_frete"] = payload.valor_frete

    resultado = db.table("pedidos").insert(pedido_data).execute()
    pedido = resultado.data[0]

    # Insere itens
    itens = [
        {
            "pedido_id": pedido["id"],
            "produto_id": str(item.produto_id),
            "lote_id": str(item.lote_id) if item.lote_id else None,
            "qtd_solicitada": item.qtd_solicitada,
            "valor_unitario": item.valor_unitario,
            "status_item": "PENDENTE",
        }
        for item in payload.itens
    ]
    if itens:
        db.table("itens_pedido").insert(itens).execute()

    obs_criacao = "Pedido criado — em gerenciamento de crédito" if payload.em_gerenciamento_credito else "Pedido criado"
    _registrar_movimentacao(pedido["id"], None, status_inicial, str(usuario.id), obs_criacao)

    # Notifica canal Teams da expedição (só quando já liberado)
    if not payload.em_gerenciamento_credito:
        cliente_res = get_service_db().table("clientes").select("nome").eq("id", str(payload.cliente_id)).execute()
        cliente_nome = cliente_res.data[0]["nome"] if cliente_res.data else ""
        _notificar_teams_nova_ov(pedido, cliente_nome)

    return pedido


def criar_comunicado_uso(payload, usuario: UsuarioOut) -> dict:
    """Lança um faturamento de comunicado de uso (consignado utilizado).

    Cria o pedido já FATURADO, sem itens e sem etapas logísticas, e registra
    a movimentação para FATURADO na data informada — para o dashboard atribuir
    ao mês correto.
    """
    db = get_service_db()

    existe = db.table("pedidos").select("id").eq("numero_pedido", payload.numero_pedido).execute()
    if existe.data:
        raise HTTPException(
            status_code=409,
            detail=f"Já existe uma OV/lançamento com o número '{payload.numero_pedido}'.",
        )

    data_fat = payload.data_faturamento or date.today()
    # Meio-dia UTC = 09h BRT — garante que a data BRT do faturamento seja a escolhida.
    ts_fat = f"{data_fat.isoformat()}T12:00:00+00:00"

    pedido_data = {
        "numero_pedido":         payload.numero_pedido,
        "cliente_id":            str(payload.cliente_id),
        "tipo_frete":            "FOB",
        "tipo_operacao":         "COMUNICADO_USO",
        "status":                StatusPedido.FATURADO.value,
        "prioridade":            "NORMAL",
        "canal":                 payload.canal or None,
        "data_prevista_entrega": data_fat.isoformat(),
        "numero_nf":             payload.numero_nf,
        "valor_nf":              payload.valor_nf,
        "valor_produtos":        payload.valor_produtos if payload.valor_produtos is not None else payload.valor_nf,
        "observacoes":           payload.observacoes or "Comunicado de uso (consignado) — sem processo logístico",
        "criado_por":            None,
        "criado_em":             ts_fat,
        "atualizado_em":         _agora(),
    }
    _emp = getattr(payload, "empenho_id", None)
    if _emp:
        pedido_data["empenho_id"] = str(_emp)
    resultado = db.table("pedidos").insert(pedido_data).execute()
    pedido = resultado.data[0]

    # A movimentação de FATURADO é o que o faturamento usa para atribuir a
    # competência. Cria já — se falhar, desfaz o pedido para não deixar um
    # comunicado "faturado" órfão (que ficaria fora do faturamento).
    usuarios = db.table("usuarios").select("id").limit(1).execute()
    uid = usuarios.data[0]["id"] if usuarios.data else None
    try:
        db.table("movimentacoes").insert({
            "pedido_id":       pedido["id"],
            "status_anterior": None,
            "status_novo":     StatusPedido.FATURADO.value,
            "usuario_id":      uid,
            "observacao":      f"Comunicado de uso — NF {payload.numero_nf}",
            "criado_em":       ts_fat,
        }).execute()
    except Exception:
        db.table("pedidos").delete().eq("id", pedido["id"]).execute()
        raise

    # Itens (informativos — o comunicado já entra FATURADO, sem separação).
    # Não bloqueiam o faturamento: se falharem, o comunicado permanece válido.
    itens = [
        {
            "pedido_id":      pedido["id"],
            "produto_id":     str(item.produto_id),
            "qtd_solicitada": item.qtd_solicitada,
            "valor_unitario": getattr(item, "valor_unitario", None),
            "status_item":    "OK",
        }
        for item in (getattr(payload, "itens", None) or [])
    ]
    if itens:
        try:
            db.table("itens_pedido").insert(itens).execute()
        except Exception:
            pass

    return pedido


# Campos da OV que podem ser editados no momento da reativação
_CAMPOS_EDITAVEIS_REATIVAR = {
    "numero_pedido", "cliente_id", "transportadora_id", "tipo_frete", "valor_frete",
    "tipo_operacao", "canal", "local_entrega", "data_prevista_entrega",
    "data_prevista_coleta", "prioridade", "observacoes",
}

_CAMPOS_LABEL_REATIVAR = {
    "numero_pedido": "Nº da OV", "cliente_id": "Cliente", "transportadora_id": "Transportadora",
    "tipo_frete": "Tipo de frete", "valor_frete": "Valor do frete", "tipo_operacao": "Tipo de operação",
    "canal": "Canal de venda", "local_entrega": "Local de entrega", "data_prevista_entrega": "Data prevista de entrega",
    "data_prevista_coleta": "Data prevista de coleta", "prioridade": "Prioridade", "observacoes": "Observações",
}


def reativar_pedido(pedido_id: str, motivo: str, usuario: UsuarioOut, dados: Optional[dict] = None) -> dict:
    """Reativa uma OV cancelada: volta para LIBERADO e registra ocorrência auditável.

    `dados` (opcional) permite editar campos da OV na mesma ação (data, cliente, canal, etc.).
    """
    db = get_service_db()
    pedido = obter_pedido(pedido_id)

    if pedido["status"] != StatusPedido.CANCELADO.value:
        raise HTTPException(status_code=400, detail="Só é possível reativar OVs canceladas")
    if not motivo or len(motivo.strip()) < 5:
        raise HTTPException(status_code=400, detail="Informe o motivo da reativação (mín. 5 caracteres)")

    from app.services.inventario_service import _get_usuario_real
    uid = _get_usuario_real(str(usuario.id))
    agora = _agora()
    motivo = motivo.strip()

    # Monta as alterações de campos (apenas os que realmente mudaram)
    update: dict = {"atualizado_em": agora}
    alteracoes: list[str] = []
    if dados:
        campos = {k: v for k, v in dados.items() if k in _CAMPOS_EDITAVEIS_REATIVAR}

        novo_numero = campos.get("numero_pedido")
        if novo_numero:
            novo_numero = str(novo_numero).strip().upper()
            if novo_numero != pedido.get("numero_pedido"):
                conflito = db.table("pedidos").select("id").eq("numero_pedido", novo_numero)\
                    .neq("status", StatusPedido.CANCELADO.value).neq("id", pedido_id).execute().data
                if conflito:
                    raise HTTPException(status_code=409, detail=f"Já existe uma OV ativa com o número '{novo_numero}'.")
            campos["numero_pedido"] = novo_numero

        for campo, valor in campos.items():
            atual = pedido.get(campo)
            if valor == "":
                valor = None
            if valor != atual:
                update[campo] = valor
                de = atual if atual not in (None, "") else "—"
                para = valor if valor not in (None, "") else "—"
                alteracoes.append(f"{_CAMPOS_LABEL_REATIVAR.get(campo, campo)}: {de} → {para}")

    # Comunicado de uso não tem processo logístico — volta direto a FATURADO.
    tipo_op_final = update.get("tipo_operacao", pedido.get("tipo_operacao"))
    eh_comunicado = tipo_op_final == "COMUNICADO_USO"
    destino = StatusPedido.FATURADO.value if eh_comunicado else StatusPedido.LIBERADO.value
    destino_label = "FATURADO (sem processo logístico)" if eh_comunicado else "OV Recebida"
    update["status"] = destino

    db.table("pedidos").update(update).eq("id", pedido_id).execute()

    desc = (
        f"OV {update.get('numero_pedido', pedido['numero_pedido'])} reativada "
        f"(voltou de CANCELADO para {destino_label}).\nMotivo: {motivo}"
    )
    if alteracoes:
        desc += "\n\nAlterações aplicadas na reativação:\n- " + "\n- ".join(alteracoes)

    db.table("ocorrencias").insert({
        "pedido_id":      pedido_id,
        "tipo":           "OV Reativada após Cancelamento",
        "descricao":      desc,
        "responsavel_id": uid,
        "status":         "FECHADA",
        "resolucao":      motivo,
        "resolvido_por":  uid,
        "resolvido_em":   agora,
        "criado_em":      agora,
    }).execute()

    _registrar_movimentacao(
        pedido_id, "CANCELADO", destino, uid,
        f"OV reativada após cancelamento. Motivo: {motivo}"
    )

    return db.table("pedidos").select("*").eq("id", pedido_id).execute().data[0]


_CANAIS_META = ["URO", "VASCULAR", "REALCLOSURE", "LICITACAO"]


def obter_meta(competencia: str) -> dict:
    """Metas por canal de um mês. A meta total = soma das metas dos canais."""
    db = get_service_db()
    rows = db.table("metas_faturamento").select("canal, valor").eq("competencia", competencia).execute().data
    por_canal = {r.get("canal"): float(r["valor"]) for r in rows if r.get("valor") is not None}
    tem_meta = any(por_canal.get(c) for c in _CANAIS_META)
    total = round(sum(por_canal.get(c, 0.0) for c in _CANAIS_META), 2)
    return {
        "competencia": competencia,
        "valor": total if tem_meta else None,
        "por_canal": {c: por_canal.get(c) for c in _CANAIS_META},
    }


def definir_meta(competencia: str, canal: str, valor: float) -> dict:
    db = get_service_db()
    db.table("metas_faturamento").upsert({
        "competencia": competencia,
        "canal": canal,
        "valor": valor,
        "atualizado_em": _agora(),
    }).execute()
    return {"competencia": competencia, "canal": canal, "valor": valor}


def obter_referencia_nf_cliente(cliente_id: str) -> dict:
    """Estatísticas do histórico de NF de um cliente — base da validação anti-erro."""
    db = get_service_db()
    rows = db.table("pedidos").select("valor_nf").eq("cliente_id", cliente_id)\
        .neq("status", "CANCELADO").execute().data
    vals = sorted(float(r["valor_nf"]) for r in rows if r.get("valor_nf"))
    if not vals:
        return {"qtd": 0, "mediana": None, "media": None, "maximo": None}
    n = len(vals)
    mediana = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2
    return {
        "qtd": n,
        "mediana": round(mediana, 2),
        "media": round(sum(vals) / n, 2),
        "maximo": round(vals[-1], 2),
    }


def listar_familia(numero_pedido: str) -> list[dict]:
    """Retorna todas as remessas (original + derivadas) de uma OV."""
    db = get_service_db()
    resultado = (
        db.table("pedidos")
        .select("id,numero_pedido,status,remessa_numero,pedido_pai_id,numero_nf,atualizado_em,criado_em,prioridade")
        .eq("numero_pedido", numero_pedido)
        .order("remessa_numero")
        .execute()
    )
    hoje = date.today().isoformat()
    for p in resultado.data:
        p["atrasado"] = False
    return resultado.data


def listar_pedidos(
    status_filter: Optional[str] = None,
    cliente_id: Optional[str] = None,
    data_inicio: Optional[date] = None,
    data_fim: Optional[date] = None,
    prioridade: Optional[str] = None,
    atrasados: Optional[bool] = None,
) -> list[dict]:
    db = get_service_db()
    query = db.table("pedidos").select(
        "*, clientes(id, nome), transportadoras(id, nome)"
    )
    # Comunicado de uso não passa pela logística — não aparece no quadro operacional.
    query = query.neq("tipo_operacao", "COMUNICADO_USO")

    if status_filter:
        query = query.eq("status", status_filter)
    if cliente_id:
        query = query.eq("cliente_id", cliente_id)
    if prioridade:
        query = query.eq("prioridade", prioridade)
    if data_inicio:
        query = query.gte("data_prevista_entrega", data_inicio.isoformat())
    if data_fim:
        query = query.lte("data_prevista_entrega", data_fim.isoformat())

    resultado = query.order("prioridade", desc=True).order("data_prevista_entrega").execute()
    pedidos = resultado.data

    hoje = date.today().isoformat()
    for p in pedidos:
        p["atrasado"] = (
            p["data_prevista_entrega"] < hoje
            and p["status"] not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)
        )
        p["cliente_nome"] = p.get("clientes", {}).get("nome", "") if p.get("clientes") else ""
        p["transportadora_nome"] = p.get("transportadoras", {}).get("nome") if p.get("transportadoras") else None

    # Valor "parado" por OV = Σ qtd × valor_unitário dos itens (cai para o valor
    # da NF quando os itens não têm preço). Alimenta o total por etapa no kanban.
    ids = [p["id"] for p in pedidos]
    valor_itens: dict[str, float] = {}
    for i in range(0, len(ids), 40):
        its = db.table("itens_pedido").select("pedido_id, qtd_solicitada, valor_unitario")\
            .in_("pedido_id", ids[i:i + 40]).execute().data
        for it in its:
            pid = it.get("pedido_id")
            if not pid:
                continue
            valor_itens[pid] = valor_itens.get(pid, 0.0) + \
                (float(it.get("qtd_solicitada") or 0) * float(it.get("valor_unitario") or 0))
    for p in pedidos:
        v = valor_itens.get(p["id"], 0.0)
        if not v and p.get("valor_nf"):
            v = float(p["valor_nf"])
        p["valor_ov"] = round(v, 2)

    # Data de faturamento (movimentação -> FATURADO, BRT) por pedido.
    fat: dict[str, str] = {}
    for i in range(0, len(ids), 40):
        movs = db.table("movimentacoes").select("pedido_id, criado_em")\
            .eq("status_novo", "FATURADO").in_("pedido_id", ids[i:i + 40]).execute().data
        for m in movs:
            ts = m.get("criado_em")
            pid = m.get("pedido_id")
            if not ts or not pid:
                continue
            try:
                d = (datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc) - timedelta(hours=3)).date().isoformat()
            except Exception:
                continue
            if pid not in fat or d > fat[pid]:
                fat[pid] = d
    for p in pedidos:
        p["data_faturamento"] = fat.get(p["id"])

    if atrasados is not None:
        pedidos = [p for p in pedidos if p["atrasado"] == atrasados]

    # Críticos e atrasados primeiro
    pedidos.sort(key=lambda p: (
        0 if p["prioridade"] == Prioridade.CRITICA.value else (1 if p["prioridade"] == Prioridade.ALTA.value else 2),
        0 if p["atrasado"] else 1,
        p["data_prevista_entrega"],
    ))

    return pedidos


def obter_pedido(pedido_id: str) -> dict:
    db = get_service_db()
    resultado = db.table("pedidos").select(
        "*, clientes(*), transportadoras(*), empenhos(numero, numero_pregao, tipo), itens_pedido(*, produtos(*), lotes(*))"
    ).eq("id", pedido_id).single().execute()

    if not resultado.data:
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    p = resultado.data
    hoje = date.today().isoformat()
    p["atrasado"] = (
        p["data_prevista_entrega"] < hoje
        and p["status"] not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)
    )
    # Mapeia nomes do join (plural → singular) para o frontend
    p["cliente"] = p.pop("clientes", None)
    p["transportadora"] = p.pop("transportadoras", None)
    # Dados da licitação (pregão + empenho/NE) — para achar a OV pelo e-mail
    emp = p.pop("empenhos", None)
    p["licitacao"] = {
        "numero_pregao": emp.get("numero_pregao"),
        "numero_empenho": emp.get("numero"),
        "tipo": emp.get("tipo"),
    } if emp else None
    p["itens"] = p.pop("itens_pedido", []) or []
    p["cliente_nome"] = p.get("cliente", {}).get("nome", "") if p.get("cliente") else ""
    p["transportadora_nome"] = p.get("transportadora", {}).get("nome", "") if p.get("transportadora") else ""
    return p


def alterar_status(pedido_id: str, novo_status: str, usuario: UsuarioOut,
                   observacao: Optional[str] = None) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    _validar_transicao(pedido["status"], novo_status)

    db.table("pedidos").update({
        "status": novo_status,
        "atualizado_em": _agora(),
    }).eq("id", pedido_id).execute()

    _registrar_movimentacao(pedido_id, pedido["status"], novo_status, str(usuario.id), observacao)

    # Quando crédito aprovado, notifica Teams (mesma notificação de OV nova)
    if pedido["status"] == StatusPedido.AGUARD_CREDITO.value and novo_status == StatusPedido.LIBERADO.value:
        cliente_res = get_service_db().table("clientes").select("nome").eq("id", pedido["cliente_id"]).execute()
        cliente_nome = cliente_res.data[0]["nome"] if cliente_res.data else ""
        _notificar_teams_nova_ov(pedido, cliente_nome)

    # Alertas Teams para eventos que exigem atenção imediata
    cli = pedido.get("cliente_nome", "")
    obs = f"\n📝 {observacao}" if observacao else ""
    if novo_status == StatusPedido.DIVERGENCIA.value:
        _enviar_teams(f"⚠️ **Divergência aberta — {pedido['numero_pedido']}**\n\n👤 Cliente: **{cli}**{obs}")
    elif novo_status == StatusPedido.BLOQUEADO.value:
        _enviar_teams(f"🔒 **OV bloqueada — {pedido['numero_pedido']}**\n\n👤 Cliente: **{cli}**{obs}")

    return obter_pedido(pedido_id)


# ── Separação ──────────────────────────────────────────────────────────────────

def iniciar_separacao(pedido_id: str, usuario: UsuarioOut) -> dict:
    pedido = obter_pedido(pedido_id)
    if pedido["status"] not in (StatusPedido.LIBERADO.value, StatusPedido.SEPARADO.value):
        raise HTTPException(status_code=422, detail="Pedido não está disponível para separação")

    db = get_service_db()
    sep = db.table("separacoes").insert({
        "pedido_id": pedido_id,
        "operador_id": str(usuario.id),
        "inicio": _agora(),
    }).execute().data[0]

    alterar_status(pedido_id, StatusPedido.EM_SEPARACAO.value, usuario, "Separação iniciada")
    return sep


def finalizar_separacao(pedido_id: str, payload: FinalizarSeparacaoRequest,
                         usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Atualiza qtd separada nos itens
    for item in payload.itens:
        update = {"qtd_separada": item["qtd_separada"], "status_item": "SEPARADO"}
        if item.get("lote_id"):
            update["lote_id"] = item["lote_id"]
        db.table("itens_pedido").update(update).eq("id", item["item_id"]).execute()

    # Finaliza registro de separação
    sep = db.table("separacoes").select("id").eq("pedido_id", pedido_id).order("inicio", desc=True).limit(1).execute()
    if sep.data:
        db.table("separacoes").update({"fim": _agora(), "observacao": payload.observacao}).eq("id", sep.data[0]["id"]).execute()

    alterar_status(pedido_id, StatusPedido.SEPARADO.value, usuario, payload.observacao or "Separação concluída")
    return obter_pedido(pedido_id)


# ── Conferência ────────────────────────────────────────────────────────────────

def iniciar_conferencia(pedido_id: str, usuario: UsuarioOut) -> dict:
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.SEPARADO.value:
        raise HTTPException(status_code=422, detail="Pedido precisa estar SEPARADO para iniciar conferência")

    db = get_service_db()
    conf = db.table("conferencias").insert({
        "pedido_id": pedido_id,
        "conferente_id": str(usuario.id),
        "inicio": _agora(),
        "resultado": "PENDENTE",
    }).execute().data[0]

    alterar_status(pedido_id, StatusPedido.EM_CONFERENCIA.value, usuario, "Conferência iniciada")
    return conf


def finalizar_conferencia(pedido_id: str, payload: FinalizarConferenciaRequest,
                           usuario: UsuarioOut) -> dict:
    db = get_service_db()

    for item in payload.itens_conferidos:
        update = {
            "qtd_conferida": item["qtd_conferida"],
            "status_item": "CONFERIDO" if payload.resultado == ResultadoConferencia.OK else "DIVERGENCIA",
        }
        if item.get("qtd_divergente"):
            update["qtd_divergente"] = item["qtd_divergente"]
        db.table("itens_pedido").update(update).eq("id", item["item_id"]).execute()

    # Finaliza registro
    conf = db.table("conferencias").select("id").eq("pedido_id", pedido_id).order("inicio", desc=True).limit(1).execute()
    if conf.data:
        db.table("conferencias").update({
            "fim": _agora(),
            "resultado": payload.resultado.value,
            "observacao": payload.observacao,
        }).eq("id", conf.data[0]["id"]).execute()

    novo_status = (
        StatusPedido.CONFERIDO.value
        if payload.resultado == ResultadoConferencia.OK
        else StatusPedido.DIVERGENCIA.value
    )
    alterar_status(pedido_id, novo_status, usuario, payload.observacao)
    return obter_pedido(pedido_id)


# ── Tratativa ──────────────────────────────────────────────────────────────────

def registrar_tratativa(pedido_id: str, payload: TratativaRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    db.table("tratativas").insert({
        "pedido_id": pedido_id,
        "responsavel_id": str(usuario.id),
        "decisao": payload.decisao.value,
        "justificativa": payload.justificativa,
        "retrabalho": payload.retrabalho,
        "tempo_retrabalho_min": payload.tempo_retrabalho_min,
        "criado_em": _agora(),
    }).execute()

    if payload.decisao == DecisaoTratativa.CORRIGIR:
        proximo = StatusPedido.EM_SEPARACAO.value
    elif payload.decisao == DecisaoTratativa.EXPEDIR_PARCIAL:
        proximo = StatusPedido.CONFERIDO.value
    else:
        proximo = StatusPedido.BLOQUEADO.value

    alterar_status(pedido_id, proximo, usuario, f"Tratativa: {payload.justificativa}")
    return obter_pedido(pedido_id)


# ── Faturamento ────────────────────────────────────────────────────────────────

def registrar_cotacao_frete(pedido_id: str, payload: "CotacaoFreteRequest", usuario: UsuarioOut) -> dict:
    """Registra a cotação de frete de uma OV CIF e a libera para faturamento."""
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.EM_COTACAO_FRETE.value:
        raise HTTPException(status_code=422, detail="OV não está aguardando cotação de frete")

    update_data: dict = {"atualizado_em": _agora()}
    if payload.valor_frete is not None:
        update_data["valor_frete"] = payload.valor_frete
    if payload.transportadora_id is not None:
        update_data["transportadora_id"] = str(payload.transportadora_id)
    db.table("pedidos").update(update_data).eq("id", pedido_id).execute()

    obs = "Frete cotado"
    if payload.valor_frete is not None:
        obs += f" — R$ {payload.valor_frete:.2f}"
    if payload.observacao:
        obs += f" — {payload.observacao}"
    alterar_status(pedido_id, StatusPedido.AGUARD_FATURAMENTO.value, usuario, obs)
    return obter_pedido(pedido_id)


def registrar_faturamento(pedido_id: str, payload: FaturamentoRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.AGUARD_FATURAMENTO.value:
        raise HTTPException(status_code=422, detail="Pedido não está aguardando faturamento")

    update_data: dict = {
        "numero_nf": payload.numero_nf,
        "valor_nf": payload.valor_nf,
        "valor_produtos": payload.valor_produtos,
        "valor_frete": payload.valor_frete,
        "chave_nfe": payload.chave_nfe,
        "atualizado_em": _agora(),
    }
    if payload.data_prevista_entrega:
        update_data["data_prevista_entrega"] = payload.data_prevista_entrega.isoformat()
    if payload.codigo_rastreio:
        update_data["codigo_rastreio"] = payload.codigo_rastreio

    db.table("pedidos").update(update_data).eq("id", pedido_id).execute()

    alterar_status(pedido_id, StatusPedido.FATURADO.value, usuario, f"NF {payload.numero_nf} emitida")
    return obter_pedido(pedido_id)


# ── Coleta ─────────────────────────────────────────────────────────────────────

def agendar_coleta(pedido_id: str, payload: AgendarColetaRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.FATURADO.value:
        raise HTTPException(status_code=422, detail="Pedido precisa estar FATURADO para agendar coleta")

    db.table("pedidos").update({
        "transportadora_id": str(payload.transportadora_id),
        "data_prevista_coleta": payload.data_prevista_coleta.isoformat(),
        "atualizado_em": _agora(),
    }).eq("id", pedido_id).execute()

    alterar_status(pedido_id, StatusPedido.AGUARD_COLETA.value, usuario, "Coleta agendada")
    return obter_pedido(pedido_id)


def confirmar_coleta(pedido_id: str, payload: ConfirmarColetaRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.AGUARD_COLETA.value:
        raise HTTPException(status_code=422, detail="Pedido não está aguardando coleta")

    db.table("pedidos").update({
        "data_real_coleta": payload.data_real_coleta.isoformat(),
        "atualizado_em": _agora(),
    }).eq("id", pedido_id).execute()

    from app.services.inventario_service import _get_usuario_real
    uid = _get_usuario_real(str(usuario.id))
    db.table("coletas").insert({
        "pedido_id": pedido_id,
        "motorista": payload.motorista,
        "placa": payload.placa,
        "protocolo": payload.protocolo,
        "data_real": payload.data_real_coleta.isoformat(),
        "registrado_por": uid,
        "criado_em": _agora(),
    }).execute()

    alterar_status(pedido_id, StatusPedido.COLETADO.value, usuario, f"Coleta confirmada — {payload.protocolo or ''}")
    alterar_status(pedido_id, StatusPedido.EXPEDIDO.value, usuario, "Expedição finalizada")

    # Atualiza pallet_pedidos se a OV estiver em algum pallet
    agora = _agora()
    entrada = db.table("pallet_pedidos").select("id, pallet_id").eq("pedido_id", pedido_id).eq("status", "AGUARDANDO").execute()
    if entrada.data:
        pp = entrada.data[0]
        db.table("pallet_pedidos").update({
            "coletado_em": agora,
            "status": "COLETADO",
        }).eq("id", pp["id"]).execute()
        # Fecha o pallet se não houver mais OVs aguardando
        # Pallets fixos voltam para ABERTO (nunca fecham permanentemente)
        PALLETS_FIXOS = ['PLT-BRIX', 'PLT-RR CARGO', 'PLT-CORREIOS', 'PLT-OUTROS']
        restantes = db.table("pallet_pedidos").select("id").eq("pallet_id", pp["pallet_id"]).eq("status", "AGUARDANDO").execute()
        if not restantes.data:
            pallet_info = db.table("pallets").select("codigo").eq("id", pp["pallet_id"]).execute().data
            codigo = pallet_info[0]["codigo"] if pallet_info else ""
            if codigo in PALLETS_FIXOS:
                db.table("pallets").update({"status": "ABERTO"}).eq("id", pp["pallet_id"]).execute()
            else:
                db.table("pallets").update({
                    "status": "COLETADO",
                    "data_real_coleta": agora,
                }).eq("id", pp["pallet_id"]).execute()

    return obter_pedido(pedido_id)


# ── Ocorrências ────────────────────────────────────────────────────────────────

def criar_ocorrencia(payload: OcorrenciaCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Resolve pedido_id: aceita UUID ou número de OV (ex: OV015406)
    pedido_id = payload.pedido_id.strip()
    if pedido_id.upper().startswith("OV"):
        resultado = db.table("pedidos").select("id").eq("numero_pedido", pedido_id.upper()).execute()
        if not resultado.data:
            raise HTTPException(status_code=404, detail=f"Pedido '{pedido_id}' não encontrado")
        pedido_id = resultado.data[0]["id"]

    # Busca usuário real
    from app.services.inventario_service import _get_usuario_real
    uid = _get_usuario_real(str(usuario.id))

    result = db.table("ocorrencias").insert({
        "pedido_id": pedido_id,
        "tipo": payload.tipo,
        "descricao": payload.descricao,
        "responsavel_id": uid,
        "status": "ABERTA",
        "retrabalho": True,
        "criado_em": _agora(),
    }).execute()
    return result.data[0]


def fechar_ocorrencia(ocorrencia_id: str, resolucao: str, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    from app.services.inventario_service import _get_usuario_real
    uid = _get_usuario_real(str(usuario.id))
    result = db.table("ocorrencias").update({
        "status": "FECHADA",
        "resolucao": resolucao,
        "resolvido_por": uid,
        "resolvido_em": _agora(),
    }).eq("id", ocorrencia_id).execute()
    return result.data[0]


# ── Dashboard ──────────────────────────────────────────────────────────────────

def obter_dashboard_operacional() -> dict:
    db = get_service_db()
    hoje = date.today().isoformat()

    # Comunicado de uso não é logística — fora das contagens operacionais.
    todos = db.table("pedidos").select("status, data_prevista_entrega")\
        .neq("tipo_operacao", "COMUNICADO_USO").execute().data
    expedidos_hoje = db.table("pedidos").select("id").eq("status", StatusPedido.EXPEDIDO.value)\
        .neq("tipo_operacao", "COMUNICADO_USO")\
        .gte("atualizado_em", f"{hoje}T00:00:00").execute().data
    ocorrencias = db.table("ocorrencias").select("id").eq("status", "ABERTA").execute().data

    por_status: dict[str, dict] = {}
    atrasados_total = 0
    for p in todos:
        s = p["status"]
        atrasado = (
            p["data_prevista_entrega"] < hoje
            and s not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)
        )
        if atrasado:
            atrasados_total += 1
        if s not in por_status:
            por_status[s] = {"status": s, "quantidade": 0, "atrasados": 0}
        por_status[s]["quantidade"] += 1
        if atrasado:
            por_status[s]["atrasados"] += 1

    return {
        "data": hoje,
        "total_pedidos": len([p for p in todos if p["status"] not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)]),
        "expedidos_hoje": len(expedidos_hoje),
        "atrasados": atrasados_total,
        "por_status": list(por_status.values()),
        "ocorrencias_abertas": len(ocorrencias),
    }


def obter_indicadores(data_inicio: date, data_fim: date) -> dict:
    db = get_service_db()

    # Busca OVs coletadas/expedidas no período pelo atualizado_em
    expedidos = db.table("pedidos").select("*")\
        .eq("status", StatusPedido.EXPEDIDO.value)\
        .gte("atualizado_em", f"{data_inicio.isoformat()}T00:00:00")\
        .lte("atualizado_em", f"{data_fim.isoformat()}T23:59:59")\
        .execute().data

    # OTIF = On Time In Full.
    #  - On Time: expedida até a data prevista de entrega.
    #  - In Full: unidades separadas (inventário) >= unidades pedidas (itens da OV).
    #    OVs sem itens cadastrados na criação entram como "in full" (não há dado que
    #    prove falta) — a medida fica mais precisa conforme os itens são preenchidos.
    exp_ids = [p["id"] for p in expedidos]
    pedidas: dict = {}
    separadas: dict = {}
    for i in range(0, len(exp_ids), 80):
        lote = exp_ids[i:i + 80]
        if not lote:
            continue
        for it in db.table("itens_pedido").select("pedido_id, qtd_solicitada").in_("pedido_id", lote).execute().data:
            pedidas[it["pedido_id"]] = pedidas.get(it["pedido_id"], 0.0) + float(it.get("qtd_solicitada") or 0)
        for it in db.table("inventario_itens").select("pedido_id, qtd_venda").in_("pedido_id", lote).execute().data:
            separadas[it["pedido_id"]] = separadas.get(it["pedido_id"], 0.0) + float(it.get("qtd_venda") or 0)

    def _on_time(p):
        return bool(p.get("atualizado_em") and p["atualizado_em"][:10] <= p["data_prevista_entrega"])

    def _in_full(p):
        ped = pedidas.get(p["id"])
        if not ped:
            return True
        return separadas.get(p["id"], 0.0) >= ped - 0.001

    n_exp = len(expedidos)
    otif_n = sum(1 for p in expedidos if _on_time(p) and _in_full(p))
    otif = round(otif_n / n_exp * 100, 2) if n_exp else None
    otif_on_time = round(sum(1 for p in expedidos if _on_time(p)) / n_exp * 100, 2) if n_exp else None
    otif_in_full = round(sum(1 for p in expedidos if _in_full(p)) / n_exp * 100, 2) if n_exp else None

    # Taxa de divergência: ocorrências de estoque / total expedido
    ocorrencias_div = db.table("ocorrencias").select("id")\
        .eq("tipo", "Divergência de Estoque")\
        .gte("criado_em", f"{data_inicio.isoformat()}T00:00:00")\
        .execute().data
    taxa_div = round(len(ocorrencias_div) / max(len(expedidos), 1) * 100, 2) if expedidos else None

    # Taxa de retrabalho — % de OVs expedidas que tiveram ao menos 1 ocorrência de retrabalho
    ocorrencias_ret = db.table("ocorrencias").select("pedido_id")\
        .eq("retrabalho", "true")\
        .gte("criado_em", f"{data_inicio.isoformat()}T00:00:00")\
        .execute().data
    pedidos_retrabalho = len({o["pedido_id"] for o in ocorrencias_ret if o.get("pedido_id")})
    taxa_retrab = round(pedidos_retrabalho / len(expedidos) * 100, 2) if expedidos else None

    # Backlog: OVs ativas em qualquer etapa do fluxo (exceto finalizadas)
    statuses_ativos = [
        StatusPedido.AGUARD_CREDITO.value,
        StatusPedido.LIBERADO.value,
        StatusPedido.EM_INVENTARIO.value,
        StatusPedido.AGUARD_VERIFICACAO.value,
        StatusPedido.DIVERGENCIA.value,
        StatusPedido.AGUARD_TRATATIVA.value,
        StatusPedido.EM_PROCESSO_SISTEMICO.value,
        StatusPedido.EM_COTACAO_FRETE.value,
        StatusPedido.AGUARD_FATURAMENTO.value,
        StatusPedido.FATURADO.value,
        StatusPedido.AGUARD_COLETA.value,
        StatusPedido.BLOQUEADO.value,
    ]
    backlog = db.table("pedidos").select("id")\
        .in_("status", statuses_ativos)\
        .execute().data

    # Lead time médio (separação → expedição): horas entre a criação da OV e a
    # expedição. Usa o timestamp real do EXPEDIDO (movimentação) quando houver,
    # senão cai para atualizado_em.
    def _parse_ts(ts):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None
        except Exception:
            return None

    ids_exp = [p["id"] for p in expedidos]
    exp_mov: dict = {}
    if ids_exp:
        movs = db.table("movimentacoes").select("pedido_id, criado_em")\
            .eq("status_novo", StatusPedido.EXPEDIDO.value).in_("pedido_id", ids_exp).execute().data
        for m in movs:
            pid = m.get("pedido_id")
            ts = m.get("criado_em")
            if pid and ts and (pid not in exp_mov or ts < exp_mov[pid]):
                exp_mov[pid] = ts

    leads = []
    for p in expedidos:
        inicio = _parse_ts(p.get("criado_em"))
        fim = _parse_ts(exp_mov.get(p["id"]) or p.get("atualizado_em"))
        if inicio and fim:
            h = (fim - inicio).total_seconds() / 3600
            if h >= 0:
                leads.append(h)
    lead_time = round(sum(leads) / len(leads), 1) if leads else 0

    return {
        "otif": otif,
        "otif_on_time": otif_on_time,
        "otif_in_full": otif_in_full,
        "taxa_divergencia": taxa_div if taxa_div is not None else 0,
        "taxa_retrabalho": taxa_retrab if taxa_retrab is not None else 0,
        "lead_time_medio_horas": lead_time,
        "pedidos_expedidos": len(expedidos),
        "backlog": len(backlog),
        "aderencia_cutoff": None,
    }


def obter_indicadores_detalhes(metrica: str, data_inicio: date, data_fim: date) -> list:
    from datetime import date as date_cls
    db = get_service_db()

    STATUSES_ATIVOS = [
        StatusPedido.AGUARD_CREDITO.value, StatusPedido.LIBERADO.value,
        StatusPedido.EM_INVENTARIO.value, StatusPedido.AGUARD_VERIFICACAO.value,
        StatusPedido.DIVERGENCIA.value, StatusPedido.AGUARD_TRATATIVA.value,
        StatusPedido.EM_PROCESSO_SISTEMICO.value, StatusPedido.EM_COTACAO_FRETE.value,
        StatusPedido.AGUARD_FATURAMENTO.value,
        StatusPedido.FATURADO.value, StatusPedido.AGUARD_COLETA.value,
        StatusPedido.BLOQUEADO.value,
    ]

    if metrica == "otif_atrasados":
        expedidos = db.table("pedidos").select(
            "numero_pedido,data_prevista_entrega,atualizado_em,clientes(nome)"
        ).eq("status", StatusPedido.EXPEDIDO.value)\
         .gte("atualizado_em", f"{data_inicio.isoformat()}T00:00:00")\
         .lte("atualizado_em", f"{data_fim.isoformat()}T23:59:59")\
         .execute().data
        result = []
        for p in expedidos:
            data_exp = p["atualizado_em"][:10]
            data_prev = p["data_prevista_entrega"]
            if data_exp > data_prev:
                dias = (date_cls.fromisoformat(data_exp) - date_cls.fromisoformat(data_prev)).days
                result.append({
                    "numero_pedido": p["numero_pedido"],
                    "cliente": (p.get("clientes") or {}).get("nome", "—"),
                    "data_prevista": data_prev,
                    "data_real": data_exp,
                    "dias_atraso": dias,
                })
        return sorted(result, key=lambda x: x["dias_atraso"], reverse=True)

    elif metrica == "otif_falhas":
        expedidos = db.table("pedidos").select(
            "id,numero_pedido,data_prevista_entrega,atualizado_em,clientes(nome)"
        ).eq("status", StatusPedido.EXPEDIDO.value)\
         .gte("atualizado_em", f"{data_inicio.isoformat()}T00:00:00")\
         .lte("atualizado_em", f"{data_fim.isoformat()}T23:59:59")\
         .execute().data
        exp_ids = [p["id"] for p in expedidos]
        pedidas: dict = {}
        separadas: dict = {}
        for i in range(0, len(exp_ids), 80):
            lote = exp_ids[i:i + 80]
            if not lote:
                continue
            for it in db.table("itens_pedido").select("pedido_id, qtd_solicitada").in_("pedido_id", lote).execute().data:
                pedidas[it["pedido_id"]] = pedidas.get(it["pedido_id"], 0.0) + float(it.get("qtd_solicitada") or 0)
            for it in db.table("inventario_itens").select("pedido_id, qtd_venda").in_("pedido_id", lote).execute().data:
                separadas[it["pedido_id"]] = separadas.get(it["pedido_id"], 0.0) + float(it.get("qtd_venda") or 0)
        result = []
        for p in expedidos:
            data_exp = (p.get("atualizado_em") or "")[:10]
            data_prev = p.get("data_prevista_entrega") or ""
            on_time = bool(data_exp and data_prev and data_exp <= data_prev)
            ped = pedidas.get(p["id"])
            sep = separadas.get(p["id"], 0.0)
            in_full = True if not ped else sep >= ped - 0.001
            if on_time and in_full:
                continue
            motivo = "Atrasado + Incompleto" if (not on_time and not in_full) else ("Atrasado" if not on_time else "Incompleto")
            result.append({
                "numero_pedido": p["numero_pedido"],
                "cliente": (p.get("clientes") or {}).get("nome", "—"),
                "motivo": motivo,
                "data_prevista": data_prev,
                "data_real": data_exp,
                "pedido_un": round(ped) if ped else "—",
                "separado_un": round(sep) if ped else "—",
            })
        ordem = {"Atrasado + Incompleto": 0, "Incompleto": 1, "Atrasado": 2}
        return sorted(result, key=lambda x: ordem.get(x["motivo"], 9))

    elif metrica == "divergencias":
        rows = db.table("ocorrencias").select(
            "tipo,descricao,status,criado_em,pedidos(numero_pedido,clientes(nome))"
        ).eq("tipo", "Divergência de Estoque")\
         .gte("criado_em", f"{data_inicio.isoformat()}T00:00:00")\
         .execute().data
        return [{
            "numero_pedido": (r.get("pedidos") or {}).get("numero_pedido", "—"),
            "cliente": ((r.get("pedidos") or {}).get("clientes") or {}).get("nome", "—"),
            "data": r.get("criado_em", "")[:10],
            "descricao": (r.get("descricao") or "—")[:120],
            "status_ocorrencia": r.get("status", "—"),
        } for r in rows]

    elif metrica == "backlog":
        pedidos = db.table("pedidos").select(
            "numero_pedido,status,prioridade,data_prevista_entrega,clientes(nome)"
        ).in_("status", STATUSES_ATIVOS).execute().data
        hoje = date_cls.today().isoformat()
        return sorted([{
            "numero_pedido": p["numero_pedido"],
            "cliente": (p.get("clientes") or {}).get("nome", "—"),
            "status": p["status"],
            "prioridade": p.get("prioridade", "NORMAL"),
            "data_prevista": p["data_prevista_entrega"],
            "atrasado": p["data_prevista_entrega"] < hoje,
        } for p in pedidos], key=lambda x: (not x["atrasado"], x["data_prevista"]))

    elif metrica == "retrabalhos":
        rows = db.table("ocorrencias").select(
            "tipo,descricao,status,criado_em,pedidos(numero_pedido,clientes(nome))"
        ).eq("retrabalho", "true")\
         .gte("criado_em", f"{data_inicio.isoformat()}T00:00:00")\
         .execute().data
        return [{
            "numero_pedido": (r.get("pedidos") or {}).get("numero_pedido", "—"),
            "cliente": ((r.get("pedidos") or {}).get("clientes") or {}).get("nome", "—"),
            "tipo": r.get("tipo", "—"),
            "data": r.get("criado_em", "")[:10],
            "status_ocorrencia": r.get("status", "—"),
            "descricao": (r.get("descricao") or "—")[:120],
        } for r in rows]

    elif metrica == "expedidos":
        expedidos = db.table("pedidos").select(
            "numero_pedido,data_prevista_entrega,atualizado_em,clientes(nome)"
        ).eq("status", StatusPedido.EXPEDIDO.value)\
         .gte("atualizado_em", f"{data_inicio.isoformat()}T00:00:00")\
         .lte("atualizado_em", f"{data_fim.isoformat()}T23:59:59")\
         .execute().data
        result = []
        for p in expedidos:
            data_exp = (p.get("atualizado_em") or "")[:10]
            result.append({
                "numero_pedido": p["numero_pedido"],
                "cliente": (p.get("clientes") or {}).get("nome", "—"),
                "data_expedicao": data_exp,
                "data_prevista": p.get("data_prevista_entrega", "—"),
                "no_prazo": bool(data_exp and data_exp <= (p.get("data_prevista_entrega") or "")),
            })
        return sorted(result, key=lambda x: x["data_expedicao"], reverse=True)

    elif metrica == "lead_time":
        def _p(ts):
            try:
                return datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None
            except Exception:
                return None
        expedidos = db.table("pedidos").select(
            "id,numero_pedido,criado_em,atualizado_em,clientes(nome)"
        ).eq("status", StatusPedido.EXPEDIDO.value)\
         .gte("atualizado_em", f"{data_inicio.isoformat()}T00:00:00")\
         .lte("atualizado_em", f"{data_fim.isoformat()}T23:59:59")\
         .execute().data
        ids = [p["id"] for p in expedidos]
        exp_mov: dict = {}
        if ids:
            movs = db.table("movimentacoes").select("pedido_id, criado_em")\
                .eq("status_novo", StatusPedido.EXPEDIDO.value).in_("pedido_id", ids).execute().data
            for m in movs:
                pid, ts = m.get("pedido_id"), m.get("criado_em")
                if pid and ts and (pid not in exp_mov or ts < exp_mov[pid]):
                    exp_mov[pid] = ts
        result = []
        for p in expedidos:
            inicio = _p(p.get("criado_em"))
            fim = _p(exp_mov.get(p["id"]) or p.get("atualizado_em"))
            horas = round((fim - inicio).total_seconds() / 3600, 1) if inicio and fim and fim >= inicio else None
            result.append({
                "numero_pedido": p["numero_pedido"],
                "cliente": (p.get("clientes") or {}).get("nome", "—"),
                "entrada": (p.get("criado_em") or "")[:16].replace("T", " "),
                "expedido": (exp_mov.get(p["id"]) or p.get("atualizado_em") or "")[:16].replace("T", " "),
                "horas": horas,
            })
        return sorted(result, key=lambda x: (x["horas"] is None, -(x["horas"] or 0)))

    return []


# ── Análise Gerencial ──────────────────────────────────────────────────────────

def obter_horario_criacao(data_inicio: Optional[date] = None, data_fim: Optional[date] = None) -> list:
    from datetime import timedelta
    db = get_service_db()
    hoje = date.today()
    inicio = data_inicio or (hoje - timedelta(days=29))
    fim = data_fim or hoje

    resultado = db.table("pedidos").select("criado_em").neq("status", "CANCELADO")\
        .neq("tipo_operacao", "COMUNICADO_USO")\
        .gte("criado_em", f"{inicio.isoformat()}T00:00:00")\
        .lte("criado_em", f"{fim.isoformat()}T23:59:59").execute()

    contagem = [0] * 24
    for row in resultado.data:
        ts_str = row.get("criado_em")
        if not ts_str:
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            hora_brt = (ts.hour - 3) % 24  # UTC → BRT (UTC-3)
            contagem[hora_brt] += 1
        except Exception:
            pass

    return [{"hora": h, "label": f"{h:02d}h", "total": contagem[h]} for h in range(24)]


def obter_horario_criacao_detalhe(hora: int, data_inicio: Optional[date] = None, data_fim: Optional[date] = None) -> list:
    from datetime import timedelta
    db = get_service_db()
    hoje = date.today()
    inicio = data_inicio or (hoje - timedelta(days=29))
    fim = data_fim or hoje

    resultado = db.table("pedidos").select(
        "id, numero_pedido, status, criado_em, clientes(nome)"
    ).neq("status", "CANCELADO")\
        .neq("tipo_operacao", "COMUNICADO_USO")\
        .gte("criado_em", f"{inicio.isoformat()}T00:00:00")\
        .lte("criado_em", f"{fim.isoformat()}T23:59:59").execute()

    ovs = []
    for row in resultado.data:
        ts_str = row.get("criado_em")
        if not ts_str:
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            hora_brt = (ts.hour - 3) % 24
            if hora_brt == hora:
                min_brt = ts.minute
                ovs.append({
                    "id": row["id"],
                    "numero_pedido": row["numero_pedido"],
                    "cliente": (row.get("clientes") or {}).get("nome", "—"),
                    "status": row["status"],
                    "horario": f"{hora_brt:02d}:{min_brt:02d}",
                    "data": ts_str[:10],
                })
        except Exception:
            pass

    return sorted(ovs, key=lambda x: x["data"] + x["horario"])


def obter_esforco_time(data_inicio: Optional[date] = None, data_fim: Optional[date] = None) -> dict:
    from datetime import timedelta
    db = get_service_db()
    hoje = date.today()
    # Default: mês corrente (não os últimos 30 dias).
    inicio = data_inicio or date(hoje.year, hoje.month, 1)
    fim = data_fim or hoje

    # Unidades por OV = soma de qtd_venda dos itens do inventário (itens_pedido
    # não é populado). É a quantidade efetivamente separada/vendida da OV.
    resultado = db.table("pedidos").select(
        "id, numero_pedido, criado_em, clientes(nome), inventario_itens(qtd_venda)"
    ).neq("status", "CANCELADO")\
        .neq("tipo_operacao", "COMUNICADO_USO")\
        .gte("criado_em", f"{inicio.isoformat()}T00:00:00")\
        .lte("criado_em", f"{fim.isoformat()}T23:59:59").execute()

    simples: list = []
    media: list = []
    complexa: list = []
    por_dia: dict = {}

    for row in resultado.data:
        itens = row.get("inventario_itens") or []
        total_un = sum(float(i.get("qtd_venda") or 0) for i in itens)

        criado_em = row.get("criado_em")
        dia = None
        label_dia = None
        if criado_em:
            try:
                ts = datetime.fromisoformat(criado_em.replace("Z", "+00:00"))
                ts_brt = ts - timedelta(hours=3)
                dia = ts_brt.strftime("%Y-%m-%d")
                label_dia = ts_brt.strftime("%d/%m")
            except Exception:
                pass

        cliente = (row.get("clientes") or {}).get("nome")
        ov = {
            "id": row.get("id"),
            "numero": row.get("numero_pedido"),
            "cliente": cliente,
            "unidades": round(total_un),
            "dia": label_dia,
        }

        if total_un <= 20:
            simples.append(ov)
        elif total_un <= 100:
            media.append(ov)
        else:
            complexa.append(ov)

        if dia:
            if dia not in por_dia:
                por_dia[dia] = {"total_unidades": 0.0, "num_ovs": 0, "ovs": []}
            por_dia[dia]["total_unidades"] += total_un
            por_dia[dia]["num_ovs"] += 1
            por_dia[dia]["ovs"].append(ov)

    total = len(simples) + len(media) + len(complexa)

    dias_ordenados = []
    d = inicio
    while d <= fim:
        dia_str = d.isoformat()
        entry = por_dia.get(dia_str, {"total_unidades": 0.0, "num_ovs": 0, "ovs": []})
        dias_ordenados.append({
            "data": dia_str,
            "label": d.strftime("%d/%m"),
            "total_unidades": round(entry["total_unidades"]),
            "num_ovs": entry["num_ovs"],
            "ovs": entry["ovs"],
        })
        d += timedelta(days=1)

    def _pct(n):
        return round(n / total * 100) if total else 0

    return {
        "complexidade": [
            {"categoria": "Simples", "cor": "#22C55E", "total": len(simples),
             "percentual": _pct(len(simples)), "ovs": simples},
            {"categoria": "Média", "cor": "#6366F1", "total": len(media),
             "percentual": _pct(len(media)), "ovs": media},
            {"categoria": "Complexa", "cor": "#F97316", "total": len(complexa),
             "percentual": _pct(len(complexa)), "ovs": complexa},
        ],
        "por_dia": dias_ordenados,
    }


def obter_gargalo_etapas(data_inicio: Optional[date] = None, data_fim: Optional[date] = None) -> dict:
    """Tempo médio que as OVs passam em cada etapa do fluxo (identifica o gargalo).

    Baseado nas movimentações: para cada OV, mede o intervalo entre atingir uma
    etapa e a seguinte, e tira a média por etapa sobre as OVs do período.
    """
    db = get_service_db()
    hoje = date.today()
    inicio = data_inicio or date(hoje.year, hoje.month, 1)
    fim = data_fim or hoje

    pedidos = db.table("pedidos").select("id, criado_em").neq("status", "CANCELADO")\
        .gte("criado_em", f"{inicio.isoformat()}T00:00:00")\
        .lte("criado_em", f"{fim.isoformat()}T23:59:59").execute().data
    ids = [p["id"] for p in pedidos]
    criado_map = {p["id"]: p.get("criado_em") for p in pedidos}

    movs_by_ped: dict = {}
    for i in range(0, len(ids), 80):
        lote = ids[i:i + 80]
        if not lote:
            continue
        rows = db.table("movimentacoes").select("pedido_id, status_novo, criado_em")\
            .in_("pedido_id", lote).order("criado_em").execute().data
        for m in rows:
            movs_by_ped.setdefault(m["pedido_id"], []).append(m)

    def _p(ts):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None
        except Exception:
            return None

    TRANSICOES = [
        ("LIBERADO", "EM_INVENTARIO", "OV Recebida → Inventário"),
        ("EM_INVENTARIO", "AGUARD_VERIFICACAO", "Inventário → Verificação"),
        ("AGUARD_VERIFICACAO", "EM_PROCESSO_SISTEMICO", "Verificação → D365"),
        ("EM_PROCESSO_SISTEMICO", "AGUARD_FATURAMENTO", "D365 → Faturamento"),
        ("AGUARD_FATURAMENTO", "FATURADO", "Faturamento → Pallet"),
        ("FATURADO", "EXPEDIDO", "Pallet → Expedido"),
    ]
    acc = {t[2]: {"soma": 0.0, "n": 0} for t in TRANSICOES}

    for pid in ids:
        primeiro: dict = {}
        for m in movs_by_ped.get(pid, []):
            s = m.get("status_novo")
            if s and s not in primeiro:
                primeiro[s] = m.get("criado_em")
        if "LIBERADO" not in primeiro and criado_map.get(pid):
            primeiro["LIBERADO"] = criado_map[pid]
        for a, b, label in TRANSICOES:
            ta, tb = _p(primeiro.get(a)), _p(primeiro.get(b))
            if ta and tb:
                h = (tb - ta).total_seconds() / 3600
                if h >= 0:
                    acc[label]["soma"] += h
                    acc[label]["n"] += 1

    etapas = []
    for a, b, label in TRANSICOES:
        n = acc[label]["n"]
        etapas.append({
            "etapa": label,
            "media_horas": round(acc[label]["soma"] / n, 1) if n else None,
            "n_ovs": n,
        })
    validos = [e for e in etapas if e["media_horas"] is not None]
    gargalo = max(validos, key=lambda e: e["media_horas"])["etapa"] if validos else None
    return {"etapas": etapas, "gargalo": gargalo}


def varredura_alertas(horas_parada: int = 24, enviar: bool = True) -> dict:
    """Encontra OVs ativas paradas há mais de X horas e envia um resumo ao Teams."""
    from datetime import timedelta, timezone
    db = get_service_db()

    statuses_ativos = [
        StatusPedido.AGUARD_CREDITO.value, StatusPedido.LIBERADO.value,
        StatusPedido.EM_INVENTARIO.value, StatusPedido.AGUARD_VERIFICACAO.value,
        StatusPedido.DIVERGENCIA.value, StatusPedido.AGUARD_TRATATIVA.value,
        StatusPedido.EM_PROCESSO_SISTEMICO.value, StatusPedido.EM_COTACAO_FRETE.value,
        StatusPedido.AGUARD_FATURAMENTO.value,
        StatusPedido.FATURADO.value, StatusPedido.BLOQUEADO.value,
    ]
    limite = datetime.now(timezone.utc) - timedelta(hours=horas_parada)
    limite_str = limite.strftime("%Y-%m-%dT%H:%M:%S")
    rows = db.table("pedidos").select("numero_pedido, status, atualizado_em, clientes(nome)")\
        .in_("status", statuses_ativos).neq("tipo_operacao", "COMUNICADO_USO")\
        .lte("atualizado_em", limite_str)\
        .order("atualizado_em").execute().data

    def _horas(ts):
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return round((datetime.now(timezone.utc) - t).total_seconds() / 3600)
        except Exception:
            return 0

    paradas = [{
        "numero_pedido": r["numero_pedido"],
        "status": r["status"],
        "cliente": (r.get("clientes") or {}).get("nome", ""),
        "horas": _horas(r.get("atualizado_em")),
    } for r in rows]

    if enviar and paradas:
        linhas = "\n".join(
            f"• {p['numero_pedido']} ({p['cliente']}) — {p['status']} · parada há {p['horas']}h"
            for p in paradas[:20]
        )
        extra = f"\n…e mais {len(paradas) - 20}." if len(paradas) > 20 else ""
        _enviar_teams(f"🕗 **{len(paradas)} OV(s) paradas há +{horas_parada}h**\n\n{linhas}{extra}")

    return {"paradas": len(paradas), "horas_parada": horas_parada, "ovs": paradas}
