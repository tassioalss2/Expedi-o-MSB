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
    PedidoOutboundCreate,
    TratativaRequest,
    UsuarioOut,
)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hoje_brt() -> date:
    """`date.today()` puro usa o fuso do servidor (Render = UTC) — entre 21h e
    23h59 no horário de Brasília (UTC-3) isso já é 'amanhã' em UTC, adiantando
    em até 3h qualquer comparação de 'hoje' (flag de atrasado, filtro de
    período etc). Sempre usar esta função para a data de negócio do dia."""
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


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


def _validar_nf_unica(db, numero_nf: Optional[str], pedido_id_atual: Optional[str] = None) -> None:
    """Uma NF do D365 pertence a uma única venda — duas OVs com o mesmo número
    de NF é sempre erro de digitação (comprovado na conciliação de julho/2026:
    3 casos reais, um deles causou double counting de receita). Bloqueia na
    origem em vez de só descobrir no fechamento do mês."""
    numero_nf = (numero_nf or "").strip()
    if not numero_nf:
        return
    query = db.table("pedidos").select("id,numero_pedido").eq("numero_nf", numero_nf).neq("status", "CANCELADO")
    if pedido_id_atual:
        query = query.neq("id", pedido_id_atual)
    conflito = query.execute().data
    if conflito:
        raise HTTPException(
            status_code=409,
            detail=f"NF '{numero_nf}' já está registrada na OV '{conflito[0]['numero_pedido']}'. Confira o número antes de salvar — cada NF pertence a uma única venda.",
        )


_STATUSES_PERMITE_DERIVAR = {"FATURADO", "AGUARD_COLETA", "EXPEDIDO"}

# Operações que não passam pela logística: nascem FATURADO, sem separação,
# conferência ou coleta. Ficam fora de todo painel operacional (kanban, SLA,
# alertas, dashboard) — no financeiro elas contam normalmente.
_OPERACOES_SEM_LOGISTICA = ("COMUNICADO_USO", "DEVOLUCAO")


def _so_logistica(query):
    """Tira do resultado as operações sem processo logístico.

    Centralizado porque a exclusão é repetida em 7 consultas — quando só o
    comunicado de uso era excluído, as devoluções lançadas depois passaram a
    aparecer no kanban como cartões de FATURADO.
    """
    for op in _OPERACOES_SEM_LOGISTICA:
        query = query.neq("tipo_operacao", op)
    return query


def _gravar_data_faturamento(db, pedido_id: str, quando: str) -> None:
    """Competência do faturamento (v31). Best-effort: se a coluna ainda não existe,
    o faturamento acontece do mesmo jeito e a competência cai no fallback pela
    movimentação de FATURADO."""
    try:
        db.table("pedidos").update({"data_faturamento": quando}).eq("id", pedido_id).execute()
    except Exception:
        pass


# ── O QUE foi vendido × COMO foi vendido ────────────────────────────────────────
#
# `canal` misturava as duas coisas ("LICITACAO_URO" = licitação + Uro), e quem
# digitava tinha que acertar a linha de cabeça. Numa OV com itens de duas linhas
# não existe resposta certa: a venda inteira ia para uma meta só.
#
# Agora a LINHA sai dos itens (`linha_produto`) e o que se pergunta é só a FORMA
# (direta ou licitação). `canal` continua gravado — telas, filtros e histórico o
# usam como rótulo — mas DERIVADO, não digitado.

class _Legado:
    """Adapta uma OV já gravada ao formato que `_forma_venda_de` espera."""
    forma_venda = None

    def __init__(self, canal):
        self.canal = canal


def _forma_venda_de(payload) -> Optional[str]:
    """Forma de venda do payload, caindo no canal legado quando não vem."""
    fv = getattr(payload, "forma_venda", None)
    if fv is not None:
        return fv.value if hasattr(fv, "value") else str(fv)
    canal = getattr(payload, "canal", None)
    canal = canal.value if hasattr(canal, "value") else canal
    if canal:
        return "LICITACAO" if str(canal).startswith("LICITACAO") else "DIRETA"
    return None


def _sincronizar_linha(db, pedido_id: str, forma_venda: Optional[str]) -> None:
    """Grava forma_venda e recalcula `canal` pela linha dos itens da OV.

    Roda DEPOIS do insert dos itens (é deles que a linha sai). Best-effort de
    propósito: é campo de rótulo, não pode derrubar a criação de uma OV. Sem
    itens ou sem linha resolvida, mantém o canal que já estava lá.
    """
    try:
        from app.services import linha_produto
        update: dict = {}
        if forma_venda:
            update["forma_venda"] = forma_venda
        itens = db.table("itens_pedido").select("produto_id, qtd_solicitada, valor_unitario")            .eq("pedido_id", pedido_id).execute().data
        if itens:
            produtos = {x["id"]: x for x in
                        db.table("produtos").select("id, codigo, familia").execute().data}
            linha = linha_produto.linha_predominante(
                itens, produtos, linha_produto.mapa_por_codigo(db))
            canal = linha_produto.canal_legado(linha, forma_venda)
            if canal:
                update["canal"] = canal
        if not update:
            return
        update["atualizado_em"] = _agora()
        try:
            db.table("pedidos").update(update).eq("id", pedido_id).execute()
        except Exception:
            # Migration v13 pendente: grava o que dá (o canal derivado, que é o
            # que as telas leem) e deixa a forma de venda para depois.
            update.pop("forma_venda", None)
            if len(update) > 1:
                db.table("pedidos").update(update).eq("id", pedido_id).execute()
    except Exception:
        pass


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
            _sincronizar_linha(db, pedido["id"], _forma_venda_de(payload))
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

        # ── Os ITENS também vêm do formulário ─────────────────────────────────
        # Antes só o cabeçalho era atualizado e os itens da OV cancelada ficavam
        # de pé, calados. O caso real: OV cadastrada com os itens de um cliente,
        # devolvida para correção, recriada com o cliente certo — e seguiu com os
        # itens do cliente errado, porque o que a operadora digitou era descartado.
        # Recriar é justamente para corrigir; o formulário tem que mandar.
        itens_novos = [{
            "pedido_id": pid,
            "produto_id": str(item.produto_id),
            "lote_id": str(item.lote_id) if item.lote_id else None,
            "qtd_solicitada": float(item.qtd_solicitada),
            "valor_unitario": item.valor_unitario,
            "status_item": "PENDENTE",
        } for item in payload.itens if float(item.qtd_solicitada) > 0]

        troca_itens = ""
        if itens_novos:
            antigos = db.table("itens_pedido").select("produto_id, qtd_solicitada")\
                .eq("pedido_id", pid).execute().data
            db.table("itens_pedido").delete().eq("pedido_id", pid).execute()
            db.table("itens_pedido").insert(itens_novos).execute()

            ids = {l.get("produto_id") for l in (antigos + itens_novos) if l.get("produto_id")}
            cods = {}
            if ids:
                for r in db.table("produtos").select("id, codigo").in_("id", list(ids)).execute().data:
                    cods[r["id"]] = r.get("codigo")

            def _resumo(linhas):
                return ", ".join(f"{cods.get(l.get('produto_id')) or '?'}x{float(l.get('qtd_solicitada') or 0):g}"
                                 for l in linhas) or "—"

            de = _resumo(antigos)
            para = _resumo(itens_novos)
            if de != para:
                troca_itens = f"\nItens substituídos pelos do formulário:\n  de:   {de}\n  para: {para}"

        _sincronizar_linha(db, pid, _forma_venda_de(payload))

        # Registra ocorrência auditável
        db.table("ocorrencias").insert({
            "pedido_id":      pid,
            "tipo":           "OV Recriada após Cancelamento",
            "descricao": (
                f"OV {payload.numero_pedido} foi recriada após cancelamento.\n"
                f"Motivo informado: {payload.motivo_duplicata}\n"
                f"Operador confirmou que a recriação é intencional."
                f"{troca_itens}"
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
            uid, f"OV recriada após cancelamento. Motivo: {payload.motivo_duplicata}{troca_itens}"
        )

        return db.table("pedidos").select("*").eq("id", pid).execute().data[0]

    # ── Criação normal ─────────────────────────────────────────────────────────
    # Conferência de estoque, igual à do CRM e do outbound: a OV só entra na
    # expedição com o que existe. Aqui NÃO se oferece "aguardar produção" — a OV
    # já foi emitida no D365, o compromisso existe; o que o app resolve é não
    # mandar a expedição separar material que não está lá.
    #
    # Fora do escopo de propósito:
    #   criar_derivada     a liberação da pendência já reconferiu o estoque, e
    #                      checar de novo bloquearia a própria 2ª remessa;
    #   forcar_duplicata   recriação de OV cancelada, tratada acima e já retornada.
    analise = None
    pendencia = None
    qtd_por_ref: dict = {}
    if not payload.criar_derivada and payload.itens:
        from app.services import disponibilidade_service, pendencia_service

        analise = disponibilidade_service.analisar([{
            "ref": idx,
            "produto_id": str(item.produto_id),
            "qtd": float(item.qtd_solicitada),
            "valor_unitario": float(item.valor_unitario or 0),
        } for idx, item in enumerate(payload.itens)], sincronizar=True)

        decisao = (payload.decisao_estoque or "").strip().upper() or None
        if analise.get("tem_falta") and decisao != "PARCIAL":
            raise HTTPException(status_code=409, detail={
                "tipo": "ESTOQUE_INSUFICIENTE",
                "msg": "Não há material para toda a quantidade desta OV. A OV pode entrar "
                       "só com o disponível — o saldo fica como pendência e vira 2ª remessa.",
                "analise": analise,
            })

        atendidos = disponibilidade_service.itens_atendidos(analise)
        pendentes = disponibilidade_service.itens_pendentes(analise)
        if pendentes and not atendidos:
            raise HTTPException(status_code=409, detail={
                "tipo": "SEM_ESTOQUE",
                "msg": "Nenhuma unidade disponível para os itens desta OV — não há o que "
                       "mandar para a expedição ainda.",
                "analise": analise,
            })
        if pendentes:
            qtd_por_ref = {i.get("ref"): float(i.get("qtd_atendida") or 0)
                           for i in (analise.get("itens") or []) if i.get("ref") is not None}
            pendencia = pendencia_service.montar(
                analise, "PARCIAL", str(usuario.id), origem="NOVA_OV",
                observacao=payload.observacao_estoque,
                previsao_pcp=payload.previsao_pcp_iso())

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
        "condicao_pagamento": payload.condicao_pagamento,
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

    # Insere itens — na quantidade que existe em estoque quando houve pendência.
    itens = []
    for idx, item in enumerate(payload.itens):
        qtd = qtd_por_ref.get(idx, float(item.qtd_solicitada))
        if qtd <= 0:
            continue
        itens.append({
            "pedido_id": pedido["id"],
            "produto_id": str(item.produto_id),
            "lote_id": str(item.lote_id) if item.lote_id else None,
            "qtd_solicitada": qtd,
            "valor_unitario": item.valor_unitario,
            "status_item": "PENDENTE",
        })
    if itens:
        db.table("itens_pedido").insert(itens).execute()

    _sincronizar_linha(db, pedido["id"], _forma_venda_de(payload))

    if pendencia:
        try:
            db.table("pedidos").update({"pendencia": pendencia}).eq("id", pedido["id"]).execute()
        except Exception:
            # Migration v29 pendente: a OV entra com o disponível de todo jeito; só
            # o registro do saldo se perde, e ele fica no histórico logo abaixo.
            pass

    # Data esperada pelo cliente (informada na criação). Best-effort: a coluna
    # pode não existir ainda (migration v14) — se falhar, a OV segue normal.
    try:
        db.table("pedidos").update({"data_esperada_cliente": pedido_data["data_prevista_entrega"]}).eq("id", pedido["id"]).execute()
    except Exception:
        pass

    obs_criacao = "Pedido criado — em gerenciamento de crédito" if payload.em_gerenciamento_credito else "Pedido criado"
    if pendencia:
        faltas = "; ".join(
            f"{i.get('codigo') or '—'} faltam {float(i.get('qtd_pendente') or 0):g}"
            for i in pendencia.get("itens") or [])
        obs_criacao += (f". Estoque insuficiente — entrou só com o disponível. "
                        f"Pendência: {faltas} (R$ {float(pendencia.get('valor') or 0):,.2f}). "
                        f"O saldo entra depois como 2ª remessa nesta mesma OV.")
    _registrar_movimentacao(pedido["id"], None, status_inicial, str(usuario.id), obs_criacao)

    # Notifica canal Teams da expedição (só quando já liberado)
    if not payload.em_gerenciamento_credito:
        cliente_res = get_service_db().table("clientes").select("nome").eq("id", str(payload.cliente_id)).execute()
        cliente_nome = cliente_res.data[0]["nome"] if cliente_res.data else ""
        _notificar_teams_nova_ov(pedido, cliente_nome)

    return pedido


def criar_pedido_stub_crm(oportunidade: dict, itens: list, usuario_id: str) -> dict:
    """OV-esqueleto criada no instante em que uma oportunidade é ganha no CRM.

    Cliente e valor já são conhecidos — cai direto no kanban da Expedição, no
    primeiro card (AGUARD_DADOS_OV), com um número PROVISÓRIO (a coluna é
    UNIQUE NOT NULL, não dá para deixar em branco até o D365 gerar o real).
    A operadora completa numero_pedido, data prevista e frete direto no card;
    `completar_dados_ov` faz essa transição para LIBERADO.
    """
    db = get_service_db()
    agora = _agora()
    import uuid as _uuid
    numero_provisorio = f"CRM-{str(_uuid.uuid4())[:8].upper()}"
    data_provisoria = (_hoje_brt() + timedelta(days=7)).isoformat()

    itens_validos = [i for i in itens if i.get("produto_id") and float(i.get("qtd") or 0) > 0]
    valor_estimado = float(oportunidade.get("valor_estimado") or 0)

    pedido_data = {
        "numero_pedido": numero_provisorio,
        "cliente_id": oportunidade.get("cliente_id"),
        "tipo_operacao": "VENDA_NORMAL",
        "canal": oportunidade.get("canal"),
        "status": StatusPedido.AGUARD_DADOS_OV.value,
        "prioridade": "NORMAL",
        "data_prevista_entrega": data_provisoria,
        # Sem itens com preço, ao menos o valor estimado aparece no card —
        # senão o kanban mostraria R$ 0 numa oportunidade que valia a pena.
        "valor_nf": valor_estimado if not itens_validos else None,
        "observacoes": f"Criado automaticamente pelo CRM ao ganhar: {oportunidade.get('titulo') or ''}".strip(),
        "criado_em": agora,
        "atualizado_em": agora,
    }
    pedido = db.table("pedidos").insert(pedido_data).execute().data[0]

    if itens_validos:
        db.table("itens_pedido").insert([{
            "pedido_id": pedido["id"],
            "produto_id": i["produto_id"],
            "qtd_solicitada": float(i["qtd"]),
            "valor_unitario": float(i.get("valor_unitario") or 0) or None,
            "status_item": "PENDENTE",
        } for i in itens_validos]).execute()
        _sincronizar_linha(db, pedido["id"], _forma_venda_de(_Legado(oportunidade.get("canal"))))

    _registrar_movimentacao(pedido["id"], None, StatusPedido.AGUARD_DADOS_OV.value, usuario_id,
                            f"OV criada a partir da oportunidade ganha no CRM: {oportunidade.get('titulo') or '—'}")
    return pedido


def criar_pedido_outbound(payload: PedidoOutboundCreate, usuario: UsuarioOut) -> dict:
    """Venda outbound fechada direto pelo comercial, sem passar pelo CRM.

    Cai no mesmo primeiro card do kanban (AGUARD_DADOS_OV) que a venda ganha
    no CRM: o comercial já informa cliente, itens, frete e entrega — só falta
    o número real da OV, que operações de vendas emite no D365 e completa
    depois via `completar_dados_ov`. Sem gerenciamento de crédito aqui.

    Conferência de estoque igual à do ganho no CRM: a OV nasce só com o que a
    MSB tem, e o saldo fica registrado como pendência na própria OV (o outbound
    não tem oportunidade no CRM para guardá-la).
    """
    from app.services import disponibilidade_service, pendencia_service

    db = get_service_db()
    agora = _agora()
    import uuid as _uuid
    numero_provisorio = f"OUT-{str(_uuid.uuid4())[:8].upper()}"

    analise = disponibilidade_service.analisar([{
        "ref": idx,
        "produto_id": str(item.produto_id),
        "qtd": float(item.qtd_solicitada),
        "valor_unitario": float(item.valor_unitario or 0),
    } for idx, item in enumerate(payload.itens)], sincronizar=True)

    decisao = (payload.decisao_estoque or "").strip().upper() or None
    if analise.get("tem_falta") and decisao not in ("PARCIAL", "AGUARDAR"):
        raise HTTPException(status_code=409, detail={
            "tipo": "ESTOQUE_INSUFICIENTE",
            "msg": "Não há material para toda a quantidade desta venda. Escolha seguir "
                   "com o que temos ou aguardar a produção.",
            "analise": analise,
        })

    atendidos = disponibilidade_service.itens_atendidos(analise)
    pendentes = disponibilidade_service.itens_pendentes(analise)
    # Aguardar a produção: a venda é registrada, mas NENHUM item desce para a
    # expedição — a OV nasce em AGUARD_PRODUCAO, que não tem coluna no kanban.
    # O que foi vendido fica todo na pendência; quando o material chegar, ele é
    # somado nesta mesma OV (ainda provisória) e ela vai para "Dados da OV".
    aguardando = bool(pendentes) and (decisao == "AGUARDAR" or not atendidos)

    # Quantidade que efetivamente vai para a OV, item a item. Aguardando a
    # produção, nada vai: a OV nasce sem item nenhum e tudo fica na pendência.
    qtd_por_ref = {i.get("ref"): (0.0 if aguardando else float(i.get("qtd_atendida") or 0))
                   for i in (analise.get("itens") or []) if i.get("ref") is not None}

    # CNPJ é obrigatório neste fluxo — grava/atualiza no cadastro do cliente
    # para manter a base íntegra (venda outbound costuma envolver cliente
    # novo ou com cadastro incompleto).
    db.table("clientes").update({"cnpj": payload.cliente_cnpj}).eq("id", str(payload.cliente_id)).execute()

    pedido_data = {
        "numero_pedido": numero_provisorio,
        "cliente_id": str(payload.cliente_id),
        "transportadora_id": str(payload.transportadora_id) if payload.transportadora_id else None,
        "tipo_frete": payload.tipo_frete.value if payload.tipo_frete else "FOB",
        "tipo_operacao": payload.tipo_operacao.value if payload.tipo_operacao else "VENDA_NORMAL",
        "canal": payload.canal.value if payload.canal else None,
        "local_entrega": payload.local_entrega,
        "status": (StatusPedido.AGUARD_PRODUCAO.value if aguardando
                   else StatusPedido.AGUARD_DADOS_OV.value),
        "prioridade": payload.prioridade.value,
        "data_prevista_entrega": payload.data_prevista_entrega.isoformat(),
        "observacoes": payload.observacoes,
        "condicao_pagamento": payload.condicao_pagamento,
        "criado_por": None,
        "criado_em": agora,
        "atualizado_em": agora,
    }
    resultado = db.table("pedidos").insert(pedido_data).execute()
    pedido = resultado.data[0]

    itens = []
    for idx, item in enumerate(payload.itens):
        qtd = qtd_por_ref.get(idx, float(item.qtd_solicitada))
        if qtd <= 0:
            continue
        itens.append({
            "pedido_id": pedido["id"],
            "produto_id": str(item.produto_id),
            "lote_id": str(item.lote_id) if item.lote_id else None,
            "qtd_solicitada": qtd,
            "valor_unitario": item.valor_unitario,
            "status_item": "PENDENTE",
        })
    if itens:
        db.table("itens_pedido").insert(itens).execute()

    _sincronizar_linha(db, pedido["id"], _forma_venda_de(payload))

    try:
        db.table("pedidos").update({"data_esperada_cliente": pedido_data["data_prevista_entrega"]}).eq("id", pedido["id"]).execute()
    except Exception:
        pass

    # Aguardando: a pendência guarda a venda INTEIRA, porque a OV ficou sem item
    # nenhum e ela é o único registro do que foi vendido. Gravar só o que faltava
    # perderia os itens que tinham estoque — eles não entraram na OV nem estariam
    # na pendência para entrar depois.
    pendencia = pendencia_service.montar(
        pendencia_service.analise_venda_inteira(analise) if aguardando else analise,
        "AGUARDAR" if aguardando else (decisao or "PARCIAL"),
        str(usuario.id), origem="OUTBOUND",
        observacao=payload.observacao_estoque,
        previsao_pcp=payload.previsao_pcp_iso()) if pendentes else None
    if pendencia:
        try:
            db.table("pedidos").update({"pendencia": pendencia}).eq("id", pedido["id"]).execute()
        except Exception:
            # Migration v29 pendente: a OV é criada com o disponível de todo jeito;
            # só o registro do saldo se perde. Fica no histórico abaixo.
            pass

    detalhes = _detalhes_venda_outbound(db, payload, usuario)
    if pendencia:
        faltas = "; ".join(
            f"{i.get('codigo') or '—'} faltam {float(i.get('qtd_pendente') or 0):g}"
            for i in pendencia.get("itens") or [])
        valor_pend = float(pendencia.get("valor") or 0)
        if aguardando:
            detalhes += (f"\nSem material — o comercial escolheu aguardar a produção. Nenhum item "
                         f"desceu para a expedição: a venda inteira ficou pendente ({faltas} — "
                         f"R$ {valor_pend:,.2f}). Quando o material chegar, ela entra nesta mesma OV.")
        else:
            detalhes += (f"\nEstoque insuficiente — OV aberta só com o disponível. "
                         f"Pendência: {faltas} (R$ {valor_pend:,.2f}). "
                         f"O saldo entra depois como 2ª remessa nesta mesma OV.")
    _registrar_movimentacao(pedido["id"], None, pedido_data["status"], str(usuario.id),
                            detalhes)
    return pedido


def _detalhes_venda_outbound(db, payload: "PedidoOutboundCreate", usuario: UsuarioOut) -> str:
    """Registro auditável de tudo que o comercial preencheu ao lançar a venda —
    para ficar visível no histórico da OV, não só nos campos atuais (que podem
    ser editados depois)."""
    FRETE_LABEL = {"FOB": "FOB", "CIF_COM_VALOR": "CIF com Valor NF", "CIF_SEM_VALOR": "CIF sem Valor NF"}

    cliente_res = db.table("clientes").select("nome").eq("id", str(payload.cliente_id)).execute().data
    cliente_nome = cliente_res[0]["nome"] if cliente_res else "—"

    transportadora_nome = "a definir"
    if payload.transportadora_id:
        t = db.table("transportadoras").select("nome").eq("id", str(payload.transportadora_id)).execute().data
        transportadora_nome = t[0]["nome"] if t else "a definir"

    produtos_ids = [str(i.produto_id) for i in payload.itens]
    codigos = {}
    if produtos_ids:
        prods = db.table("produtos").select("id, codigo").in_("id", produtos_ids).execute().data
        codigos = {p["id"]: p["codigo"] for p in prods}
    itens_desc = "; ".join(
        f"{codigos.get(str(i.produto_id), '?')} x{i.qtd_solicitada:g}" for i in payload.itens
    ) or "—"

    linhas = [
        f"Venda outbound lançada por {usuario.nome}.",
        f"Cliente: {cliente_nome} (CNPJ {payload.cliente_cnpj})",
        f"Operação: {payload.tipo_operacao.value} · Canal: {payload.canal.value if payload.canal else '—'} · "
        f"Frete: {FRETE_LABEL.get(payload.tipo_frete.value, payload.tipo_frete.value)} · Prioridade: {payload.prioridade.value}",
        f"Transportadora: {transportadora_nome} · Entrega prevista: {payload.data_prevista_entrega.strftime('%d/%m/%Y')} · "
        f"Local: {payload.local_entrega or '—'}",
        f"Itens: {itens_desc}",
    ]
    if payload.observacoes:
        linhas.append(f"Obs. do comercial: {payload.observacoes}")
    return "\n".join(linhas)


def completar_dados_ov(pedido_id: str, numero_pedido: str, data_prevista_entrega: date,
                       tipo_frete: str, local_entrega: Optional[str], usuario: UsuarioOut,
                       condicao_pagamento: Optional[str] = None) -> dict:
    """A operadora preenche o que faltava na OV vinda do CRM e ela entra no
    fluxo normal — mesmo portão de duplicidade de numero_pedido da criação
    manual, porque o número real do D365 pode colidir com outra OV."""
    db = get_service_db()
    ped = db.table("pedidos").select("*").eq("id", pedido_id).single().execute().data
    if not ped:
        raise HTTPException(status_code=404, detail="OV não encontrada")
    if ped.get("status") != StatusPedido.AGUARD_DADOS_OV.value:
        raise HTTPException(status_code=400,
                            detail="Esta OV já tem os dados completos — use as ações normais de edição.")

    numero = numero_pedido.strip().upper()
    if not numero:
        raise HTTPException(status_code=422, detail="Informe o número real da OV.")
    # OV cancelada NÃO reserva o número. Caso real: operações de vendas se
    # antecipou e cadastrou a OV à mão; depois a mesma venda desceu do CRM. Ela
    # cancelou a que digitou ("pedido duplicado") e foi pôr o número do D365 na
    # que veio do CRM — e o app barrava, porque a cancelada ainda segurava o
    # número. Sem saída: a certa não podia receber o número real.
    #
    # Recriar OV (criar_pedido) e reativar já ignoram canceladas; este era o
    # único caminho que não ignorava.
    dup = db.table("pedidos").select("id, status").eq("numero_pedido", numero)\
        .neq("status", StatusPedido.CANCELADO.value).neq("id", pedido_id).execute().data
    if dup:
        raise HTTPException(status_code=409, detail=f"Já existe uma OV ativa com o número '{numero}'.")

    agora = _agora()
    update = {
        "numero_pedido": numero,
        "data_prevista_entrega": data_prevista_entrega.isoformat(),
        "tipo_frete": tipo_frete,
        "local_entrega": local_entrega,
        "condicao_pagamento": condicao_pagamento,
        "status": StatusPedido.LIBERADO.value,
        "atualizado_em": agora,
    }
    try:
        db.table("pedidos").update({"data_esperada_cliente": update["data_prevista_entrega"]}).eq("id", pedido_id).execute()
    except Exception:
        pass
    db.table("pedidos").update(update).eq("id", pedido_id).execute()
    # A OV do CRM/outbound pode ter nascido sem item (aguardando produção); os
    # itens chegaram depois, então o rótulo da linha é recalculado aqui.
    _sincronizar_linha(db, pedido_id, ped.get("forma_venda") or _forma_venda_de(_Legado(ped.get("canal"))))
    _registrar_movimentacao(pedido_id, StatusPedido.AGUARD_DADOS_OV.value, StatusPedido.LIBERADO.value,
                            str(usuario.id), f"Dados completados — OV {numero} liberada")

    # A oportunidade do CRM guarda o número real, não o provisório.
    try:
        db.table("crm_oportunidades").update({"gerado_ov_ref": numero}).eq("gerado_ov_id", pedido_id).execute()
    except Exception:
        pass

    pedido = db.table("pedidos").select("*").eq("id", pedido_id).single().execute().data
    cliente_res = db.table("clientes").select("nome").eq("id", pedido["cliente_id"]).execute()
    cliente_nome = cliente_res.data[0]["nome"] if cliente_res.data else ""
    _notificar_teams_nova_ov(pedido, cliente_nome)
    return pedido


# Depois de faturado, os itens são o que está na NF — trocar aqui divergiria do
# documento fiscal. Antes disso (mesmo em separação/conferência), a correção é
# legítima: o caso concreto foi um item sem estoque trocado por outro, e quem
# decide a troca é o comercial, não o sistema.
_STATUS_ITENS_TRAVADOS = {"FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO", "CANCELADO"}


def reclassificar_canal_licitacao(pedido_id: str, canal: str, usuario: UsuarioOut) -> dict:
    """Reclassifica para LICITACAO_URO/LICITACAO_VASCULAR uma OV que ainda não
    tem essa base definida — canal legado ('LICITACAO' puro) ou sem canal
    nenhum. Usada no drill-down do Painel Comercial (filas "Licitação legado"
    e "Sem canal") para zerar as pendências de classificação."""
    db = get_service_db()
    ped = db.table("pedidos").select("id, canal, numero_pedido, status").eq("id", pedido_id).single().execute().data
    if not ped:
        raise HTTPException(status_code=404, detail="OV não encontrada")
    canal_atual = ped.get("canal")
    if canal_atual not in ("LICITACAO", None):
        raise HTTPException(status_code=400, detail="Esta OV já tem canal definido — não está pendente de reclassificação.")

    db.table("pedidos").update({"canal": canal, "atualizado_em": _agora()}).eq("id", pedido_id).execute()
    # O canal escolhido aqui também responde o COMO, que agora tem coluna própria.
    try:
        db.table("pedidos").update({
            "forma_venda": "LICITACAO" if str(canal).startswith("LICITACAO") else "DIRETA",
        }).eq("id", pedido_id).execute()
    except Exception:
        pass
    _registrar_movimentacao(pedido_id, ped["status"], ped["status"], str(usuario.id),
                            f"Canal reclassificado: {canal_atual or 'sem canal'} → {canal}")
    return obter_pedido(pedido_id)


def editar_itens(pedido_id: str, itens: list, usuario: UsuarioOut) -> dict:
    """Substitui os itens de uma OV inteira — ex.: item sem estoque trocado por
    outro antes de faturar. Depois de FATURADO os itens são o que está na NF."""
    db = get_service_db()
    ped = db.table("pedidos").select("id, status, numero_pedido").eq("id", pedido_id).single().execute().data
    if not ped:
        raise HTTPException(status_code=404, detail="OV não encontrada")
    if ped["status"] in _STATUS_ITENS_TRAVADOS:
        raise HTTPException(
            status_code=400,
            detail=f"OV em '{ped['status']}' não tem mais os itens editáveis — depois de faturada, "
                   "o item é o que está na NF.")
    if not itens:
        raise HTTPException(status_code=422, detail="A OV precisa ter ao menos um item.")

    antigos = db.table("itens_pedido").select("produto_id, qtd_solicitada, qtd_separada")\
        .eq("pedido_id", pedido_id).execute().data
    ja_separado = any(float(i.get("qtd_separada") or 0) > 0 for i in antigos)

    db.table("itens_pedido").delete().eq("pedido_id", pedido_id).execute()
    db.table("itens_pedido").insert([{
        "pedido_id": pedido_id,
        "produto_id": str(it.produto_id),
        "lote_id": str(it.lote_id) if it.lote_id else None,
        "qtd_solicitada": it.qtd_solicitada,
        "valor_unitario": it.valor_unitario,
        "status_item": "PENDENTE",
    } for it in itens]).execute()

    obs = f"Itens da OV editados por {usuario.nome}"
    if ja_separado:
        # A separação física que já existia ficou obsoleta — quem editou
        # precisa saber que tem que refazer, não é só trocar no sistema.
        obs += " — havia separação física em andamento; ela precisa ser refeita para os novos itens."
    _registrar_movimentacao(pedido_id, ped["status"], ped["status"], str(usuario.id), obs)

    return obter_pedido(pedido_id)


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
    if not (payload.numero_nf or "").strip():
        raise HTTPException(status_code=422, detail="Informe o número da NF para lançar o comunicado de uso.")
    _validar_nf_unica(db, payload.numero_nf)

    data_fat = payload.data_faturamento or _hoje_brt()
    # Meio-dia UTC = 09h BRT — garante que a data BRT do faturamento seja a escolhida.
    ts_fat = f"{data_fat.isoformat()}T12:00:00+00:00"
    data_proc = getattr(payload, "data_procedimento", None)

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
        "af":                    getattr(payload, "af", None),
        "nome_paciente":         getattr(payload, "nome_paciente", None),
        "prontuario":            getattr(payload, "prontuario", None),
        "data_procedimento":     data_proc.isoformat() if data_proc else None,
        "criado_por":            None,
        "criado_em":             ts_fat,
        "atualizado_em":         _agora(),
    }
    _emp = getattr(payload, "empenho_id", None)
    if _emp:
        pedido_data["empenho_id"] = str(_emp)
    resultado = db.table("pedidos").insert(pedido_data).execute()
    pedido = resultado.data[0]
    _gravar_data_faturamento(db, pedido["id"], ts_fat)

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


def criar_devolucao(payload, usuario: UsuarioOut) -> dict:
    """Registra a devolução de uma venda (nota de entrada estornando uma NF
    anterior no D365). Não conta no faturamento bruto — só no líquido, onde
    entra como valor negativo, igual ao "Valor correto" que o D365 calcula
    pra essas notas (achado real: NF de devolução do Instituto de Assistência
    Médica, R$29.260, nunca tinha contrapartida no app)."""
    db = get_service_db()

    existe = db.table("pedidos").select("id").eq("numero_pedido", payload.numero_pedido).execute()
    if existe.data:
        raise HTTPException(
            status_code=409,
            detail=f"Já existe uma OV/lançamento com o número '{payload.numero_pedido}'.",
        )
    if not (payload.numero_nf or "").strip():
        raise HTTPException(status_code=422, detail="Informe o número da nota de devolução.")
    _validar_nf_unica(db, payload.numero_nf)

    data_dev = payload.data_devolucao or _hoje_brt()
    ts_dev = f"{data_dev.isoformat()}T12:00:00+00:00"
    valor_negativo = -abs(payload.valor)

    pedido_data = {
        "numero_pedido": payload.numero_pedido,
        "cliente_id": str(payload.cliente_id),
        "tipo_frete": "FOB",
        "tipo_operacao": "DEVOLUCAO",
        "status": StatusPedido.FATURADO.value,
        "prioridade": "NORMAL",
        "canal": payload.canal or None,
        "data_prevista_entrega": data_dev.isoformat(),
        "numero_nf": payload.numero_nf,
        "valor_nf": valor_negativo,
        "valor_produtos": valor_negativo,
        "observacoes": payload.motivo or "Devolução de venda",
        "criado_por": None,
        "criado_em": ts_dev,
        "atualizado_em": _agora(),
    }
    resultado = db.table("pedidos").insert(pedido_data).execute()
    pedido = resultado.data[0]
    _gravar_data_faturamento(db, pedido["id"], ts_dev)

    usuarios = db.table("usuarios").select("id").limit(1).execute()
    uid = usuarios.data[0]["id"] if usuarios.data else None
    try:
        db.table("movimentacoes").insert({
            "pedido_id": pedido["id"],
            "status_anterior": None,
            "status_novo": StatusPedido.FATURADO.value,
            "usuario_id": uid,
            "observacao": f"Devolução registrada — NF {payload.numero_nf}, R$ {abs(payload.valor):.2f}",
            "criado_em": ts_dev,
        }).execute()
    except Exception:
        db.table("pedidos").delete().eq("id", pedido["id"]).execute()
        raise

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

    # Forma de venda fica fora do update principal: a coluna é nova (v13) e não
    # pode impedir uma reativação. O canal é recalculado pelos itens junto.
    forma_nova = (dados or {}).get("forma_venda")
    if forma_nova or update.get("canal"):
        forma = forma_nova or pedido.get("forma_venda") or _forma_venda_de(_Legado(update.get("canal") or pedido.get("canal")))
        _sincronizar_linha(db, pedido_id, forma)
        if forma_nova and forma_nova != pedido.get("forma_venda"):
            rot = {"DIRETA": "Venda direta", "LICITACAO": "Licitação"}
            alteracoes.append(f"Forma de venda: {rot.get(pedido.get('forma_venda') or '', '—')} → "
                              f"{rot.get(forma_nova, forma_nova)}")

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
    hoje = _hoje_brt().isoformat()
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
    query = _so_logistica(query)

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

    hoje = _hoje_brt().isoformat()
    for p in pedidos:
        p["atrasado"] = (
            p["data_prevista_entrega"] < hoje
            and p["status"] not in (StatusPedido.EXPEDIDO.value, StatusPedido.CANCELADO.value)
        )
        p["cliente_nome"] = p.get("clientes", {}).get("nome", "") if p.get("clientes") else ""
        p["transportadora_nome"] = p.get("transportadoras", {}).get("nome") if p.get("transportadoras") else None

    # Quando a OV foi de fato expedida — o kanban mostra na coluna Expedido apenas
    # as do dia. Vem da movimentação para EXPEDIDO, e NÃO de `atualizado_em`:
    # `atualizado_em` muda a cada toque na linha (correção de frete, troca de
    # transportadora, qualquer script de manutenção), e aí OVs expedidas meses
    # antes voltavam a aparecer como se fossem de hoje.
    ids_exp = [p["id"] for p in pedidos if p.get("status") == StatusPedido.EXPEDIDO.value]
    expedido_em: dict[str, str] = {}
    for i in range(0, len(ids_exp), 40):
        movs = db.table("movimentacoes").select("pedido_id, criado_em")\
            .eq("status_novo", StatusPedido.EXPEDIDO.value)\
            .in_("pedido_id", ids_exp[i:i + 40]).execute().data
        for m in movs:
            pid, ts = m.get("pedido_id"), m.get("criado_em")
            if pid and ts and ts > expedido_em.get(pid, ""):
                expedido_em[pid] = ts
    for p in pedidos:
        p["expedido_em"] = expedido_em.get(p["id"])

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
    hoje = _hoje_brt().isoformat()
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
    # Origem no CRM: é o que habilita "Voltar para o CRM" na tela da OV. Sem isto a
    # tela não tinha como saber se a OV nasceu de uma oportunidade.
    p["crm"] = _origem_crm(db, pedido_id, p["status"])
    return p


# Depois de faturar, a OV é o documento fiscal — voltar para o CRM ali significaria
# desfazer nota emitida, o que não se resolve no app.
_STATUS_IMPEDE_VOLTAR_CRM = {"FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO", "CANCELADO"}


def _origem_crm(db, pedido_id: str, status: str) -> Optional[dict]:
    """A oportunidade que gerou esta OV, quando houver."""
    try:
        rows = db.table("crm_oportunidades")\
            .select("id, titulo, estagio, pendencia")\
            .eq("gerado_ov_id", pedido_id).eq("ativo", True).execute().data
    except Exception:
        return None
    if not rows:
        return None
    o = rows[0]
    pend = o.get("pendencia") or None
    return {
        "oportunidade_id": o["id"],
        "titulo": o.get("titulo"),
        "estagio": o.get("estagio"),
        "tem_pendencia": bool(pend and not pend.get("resolvido_em")),
        "pode_voltar": status not in _STATUS_IMPEDE_VOLTAR_CRM,
        "motivo_bloqueio": (
            "A OV já faturou — voltar para o CRM aqui significaria desfazer nota emitida."
            if status in ("FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO")
            else "A OV está cancelada." if status == "CANCELADO" else None),
    }


def devolver_ao_crm(pedido_id: str, estagio: str, motivo: Optional[str],
                    usuario: UsuarioOut) -> dict:
    """Devolve a OV para o comercial, na etapa do funil que ele escolher.

    Existe porque o repasse era de mão única: uma vez ganha, a venda descia para a
    expedição e mudar qualquer coisa (quantidade, item, preço, condição) só dava
    cancelando a OV na mão e refazendo a oportunidade — e o vínculo entre as duas
    ficava mentindo, dizendo repasse concluído.

    O que acontece:
      · a OV é CANCELADA (não apagada — o histórico e as movimentações continuam);
      · o vínculo é desfeito, e a oportunidade sai de GANHO para a etapa escolhida;
      · a pendência de estoque é descartada, porque ela era consequência da decisão
        tomada no ganho — o comercial vai decidir de novo quando ganhar outra vez.
    """
    from app.services import crm_service
    from app.services.inventario_service import _get_usuario_real

    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    origem = pedido.get("crm")
    if not origem:
        raise HTTPException(
            status_code=400,
            detail="Esta OV não veio do CRM, então não há oportunidade para devolver. "
                   "Para desfazê-la, use Cancelar OV.")
    if not origem.get("pode_voltar"):
        raise HTTPException(status_code=409, detail=origem.get("motivo_bloqueio")
                            or "Esta OV não pode voltar para o CRM.")

    destino = (estagio or "").strip().upper()
    if destino not in crm_service._ESTAGIOS_ABERTOS:
        raise HTTPException(
            status_code=422,
            detail="Escolha uma etapa aberta do funil: "
                   + ", ".join(crm_service._ESTAGIO_LABEL[e] for e in crm_service._ESTAGIOS_ABERTOS))

    agora = _agora()
    uid = _get_usuario_real(str(usuario.id))
    oid = origem["oportunidade_id"]
    razao = (motivo or "").strip() or "o comercial vai ajustar o pedido"

    # Solta de qualquer pallet em que esteja esperando coleta.
    db.table("pallet_pedidos").update({"status": "CANCELADO"})\
        .eq("pedido_id", pedido_id).eq("status", "AGUARDANDO").execute()

    db.table("pedidos").update({"status": StatusPedido.CANCELADO.value,
                                "atualizado_em": agora}).eq("id", pedido_id).execute()
    _registrar_movimentacao(
        pedido_id, pedido["status"], StatusPedido.CANCELADO.value, uid,
        f"OV devolvida ao CRM ({crm_service._ESTAGIO_LABEL.get(destino, destino)}) "
        f"por {usuario.nome}. Motivo: {razao}")

    volta = {
        "estagio": destino,
        "estagio_em": agora,
        "probabilidade": crm_service._PROB_POR_ESTAGIO.get(destino, 50),
        "ganho_em": None,
        "gerado_ov_id": None,
        "gerado_ov_ref": None,
        "pendencia": None,
        "atualizado_em": agora,
    }
    try:
        db.table("crm_oportunidades").update({**volta, "repasse_status": None,
                                              "repasse_em": None,
                                              "repasse_assumido_em": None,
                                              "repasse_assumido_por": None})\
            .eq("id", oid).execute()
    except Exception:
        db.table("crm_oportunidades").update(volta).eq("id", oid).execute()

    crm_service._log_evento(
        db, oid,
        f"↩ Devolvida da expedição para {crm_service._ESTAGIO_LABEL.get(destino, destino)} — "
        f"OV {pedido['numero_pedido']} cancelada. Motivo: {razao}",
        str(usuario.id))
    crm_service._notificar_comercial(
        f"↩ **Pedido devolveu para o CRM**\n\n"
        f"**{origem.get('titulo')}**\n"
        f"OV {pedido['numero_pedido']} foi cancelada e a oportunidade voltou para "
        f"**{crm_service._ESTAGIO_LABEL.get(destino, destino)}**.\n"
        f"Devolvida por: {usuario.nome}\n"
        f"Motivo: {razao}\n\n"
        + ("A pendência de estoque foi descartada — ao ganhar de novo, o app pergunta "
           "outra vez o que fazer com o que faltar." if origem.get("tem_pendencia") else ""))

    return {"ok": True, "oportunidade_id": oid, "estagio": destino,
            "numero_pedido": pedido["numero_pedido"]}


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
    if payload.data_prevista_entrega is not None:
        update_data["data_prevista_entrega"] = payload.data_prevista_entrega.isoformat()
    db.table("pedidos").update(update_data).eq("id", pedido_id).execute()

    obs = "Frete cotado"
    if payload.valor_frete is not None:
        obs += f" — R$ {payload.valor_frete:.2f}"
    if payload.data_prevista_entrega is not None:
        obs += f" — entrega prevista {payload.data_prevista_entrega.strftime('%d/%m/%Y')}"
    if payload.observacao:
        obs += f" — {payload.observacao}"
    alterar_status(pedido_id, StatusPedido.AGUARD_FATURAMENTO.value, usuario, obs)
    return obter_pedido(pedido_id)


def registrar_transportadora_cliente(pedido_id: str, payload: "TransportadoraClienteRequest", usuario: UsuarioOut) -> dict:
    """FOB: registra a transportadora que o cliente informou (vai na NF) e
    libera a OV para faturamento."""
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.AGUARD_TRANSPORTADORA.value:
        raise HTTPException(status_code=422, detail="OV não está aguardando a transportadora do cliente")

    update_data: dict = {
        "transportadora_id": str(payload.transportadora_id),
        "atualizado_em": _agora(),
    }
    if payload.data_prevista_entrega is not None:
        update_data["data_prevista_entrega"] = payload.data_prevista_entrega.isoformat()
    # "OUTROS": guarda o nome real em observacoes no padrão [Transp. real: X]
    nome_real = (payload.transportadora_nome_real or "").strip()
    if nome_real:
        obs_atual = pedido.get("observacoes") or ""
        nota = f"[Transp. real: {nome_real}]"
        if nota not in obs_atual:
            update_data["observacoes"] = f"{obs_atual} {nota}".strip()
    db.table("pedidos").update(update_data).eq("id", pedido_id).execute()

    obs = "Transportadora do cliente informada"
    if payload.data_prevista_entrega is not None:
        obs += f" — entrega prevista {payload.data_prevista_entrega.strftime('%d/%m/%Y')}"
    if payload.observacao:
        obs += f" — {payload.observacao}"
    alterar_status(pedido_id, StatusPedido.AGUARD_FATURAMENTO.value, usuario, obs)
    return obter_pedido(pedido_id)


def registrar_faturamento(pedido_id: str, payload: FaturamentoRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pedido = obter_pedido(pedido_id)
    if pedido["status"] != StatusPedido.AGUARD_FATURAMENTO.value:
        raise HTTPException(status_code=422, detail="Pedido não está aguardando faturamento")
    if not (payload.numero_nf or "").strip():
        # O botão do front já trava com o campo vazio, mas a API tem que travar
        # também — senão qualquer chamada direta (import, script, bug de UI)
        # deixa a OV avançar para FATURADO sem nota nenhuma.
        raise HTTPException(status_code=422, detail="Informe o número da NF para faturar a OV.")
    _validar_nf_unica(db, payload.numero_nf, pedido_id_atual=pedido_id)

    # Faturar sem valor deixava a OV em FATURADO valendo R$ 0 — ela contava
    # como nota emitida no painel e sumia do radar, só aparecendo na
    # conciliação com o D365 no fim do mês.
    faltando: list[str] = []
    if not (payload.valor_nf or 0) > 0:
        faltando.append("valor da NF")
    if pedido.get("tipo_frete") in ("CIF_COM_VALOR", "CIF_SEM_VALOR"):
        if not (payload.valor_produtos or 0) > 0:
            faltando.append("valor dos produtos")
        if not (payload.valor_frete or 0) > 0:
            faltando.append("custo do frete")
    if faltando:
        raise HTTPException(
            status_code=422,
            detail=f"Para faturar a OV, informe: {', '.join(faltando)}.",
        )

    agora_fat = _agora()
    update_data: dict = {
        "numero_nf": payload.numero_nf,
        "valor_nf": payload.valor_nf,
        "valor_produtos": payload.valor_produtos,
        "valor_frete": payload.valor_frete,
        "chave_nfe": payload.chave_nfe,
        "atualizado_em": agora_fat,
    }
    if payload.data_prevista_entrega:
        update_data["data_prevista_entrega"] = payload.data_prevista_entrega.isoformat()
    if payload.codigo_rastreio:
        update_data["codigo_rastreio"] = payload.codigo_rastreio

    # Competência do faturamento gravada como fato, não deduzida do histórico.
    # SOBRESCREVE de propósito: refaturar troca a nota, e a competência é da nota
    # que vale agora — foi o que colocou os R$ 5.600 da OV016168 no mês errado.
    try:
        db.table("pedidos").update({**update_data, "data_faturamento": agora_fat})\
            .eq("id", pedido_id).execute()
    except Exception:
        # Migration v31 pendente: fatura normalmente, competência cai no fallback.
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
    hoje = _hoje_brt().isoformat()

    todos = _so_logistica(
        db.table("pedidos").select("status, data_prevista_entrega")
    ).execute().data
    expedidos_hoje = _so_logistica(
        db.table("pedidos").select("id").eq("status", StatusPedido.EXPEDIDO.value)
    ).gte("atualizado_em", f"{hoje}T00:00:00").execute().data
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
        StatusPedido.AGUARD_TRANSPORTADORA.value,
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
        StatusPedido.AGUARD_TRANSPORTADORA.value, StatusPedido.AGUARD_FATURAMENTO.value,
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
    hoje = _hoje_brt()
    inicio = data_inicio or (hoje - timedelta(days=29))
    fim = data_fim or hoje

    resultado = _so_logistica(
        db.table("pedidos").select("criado_em").neq("status", "CANCELADO")
    ).gte("criado_em", f"{inicio.isoformat()}T00:00:00")\
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
    hoje = _hoje_brt()
    inicio = data_inicio or (hoje - timedelta(days=29))
    fim = data_fim or hoje

    resultado = _so_logistica(
        db.table("pedidos").select(
            "id, numero_pedido, status, criado_em, clientes(nome)"
        ).neq("status", "CANCELADO")
    ).gte("criado_em", f"{inicio.isoformat()}T00:00:00")\
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
    hoje = _hoje_brt()
    # Default: mês corrente (não os últimos 30 dias).
    inicio = data_inicio or date(hoje.year, hoje.month, 1)
    fim = data_fim or hoje

    # Unidades por OV = soma de qtd_venda dos itens do inventário (itens_pedido
    # não é populado). É a quantidade efetivamente separada/vendida da OV.
    resultado = _so_logistica(
        db.table("pedidos").select(
            "id, numero_pedido, criado_em, clientes(nome), inventario_itens(qtd_venda)"
        ).neq("status", "CANCELADO")
    ).gte("criado_em", f"{inicio.isoformat()}T00:00:00")\
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
    hoje = _hoje_brt()
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
        StatusPedido.AGUARD_TRANSPORTADORA.value, StatusPedido.AGUARD_FATURAMENTO.value,
        StatusPedido.FATURADO.value, StatusPedido.BLOQUEADO.value,
    ]
    limite = datetime.now(timezone.utc) - timedelta(hours=horas_parada)
    limite_str = limite.strftime("%Y-%m-%dT%H:%M:%S")
    rows = _so_logistica(
        db.table("pedidos").select("numero_pedido, status, atualizado_em, clientes(nome)")
        .in_("status", statuses_ativos)
    ).lte("atualizado_em", limite_str)\
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
