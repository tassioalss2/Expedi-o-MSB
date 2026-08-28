"""Saldo de material que a venda prometeu e o estoque não tinha.

Regra do processo: a OV só desce para operações de vendas com o que a MSB TEM.
O que faltou não vira OV — vira pendência, e o comercial passa a ver quanto,
de qual item, para quem e quanto vale. Quando o material sai da produção, a
pendência é liberada e entra como 2ª REMESSA: mesmo número de OV, nota fiscal
própria (`pedidos.remessa_numero`, que já existia para faturamento parcial).

Dois caminhos chegam aqui e cada um guarda a pendência onde ela existe:

    CRM       crm_oportunidades.pendencia — na decisão "aguardar produção" não
              existe OV alguma, então a oportunidade é o único registro possível.
    outbound  pedidos.pendencia — venda lançada direto pelo comercial, sem
              oportunidade; a OV é o registro.

O formato do jsonb é o mesmo nos dois, e é por isso que listar e liberar são um
código só em vez de dois quase iguais.

Como a pendência é liberada
---------------------------
Depende de onde a OV está, porque o certo comercialmente muda:

    sem OV ainda          → GERAR_OV   cria a OV agora, com a quantidade toda
    OV com nº provisório  → SOMAR_R1   o D365 ainda não emitiu nada; uma OV só
    OV aberta (não faturou) → SOMAR_R1 nada saiu, uma nota cobre tudo
    OV faturada/expedida  → REMESSA_2  a 1ª remessa já foi; o saldo é a 2ª
    OV cancelada          → bloqueado

Criar R2 de uma OV que ainda não faturou seria duas notas onde uma resolve — e o
app nem permite (`_STATUSES_PERMITE_DERIVAR` em pedido_service).
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.enums import StatusPedido
from app.models.schemas import UsuarioOut
from app.services import disponibilidade_service

# Números que o app gera enquanto o D365 não emitiu o real. Ver
# criar_pedido_stub_crm e criar_pedido_outbound.
_PREFIXOS_PROVISORIOS = ("CRM-", "OUT-")

# Status em que a OV já saiu — o saldo tem de virar remessa nova.
_JA_SAIU = {"FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO"}


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hoje_brt():
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _provisorio(numero: Optional[str]) -> bool:
    n = (numero or "").upper()
    return any(n.startswith(p) for p in _PREFIXOS_PROVISORIOS)


# ── Montagem ──────────────────────────────────────────────────────────────────
def montar(analise: dict, decisao: str, usuario_id: str, origem: str,
           observacao: Optional[str] = None, previsao_pcp: Optional[str] = None) -> Optional[dict]:
    """O jsonb da pendência a partir da análise de disponibilidade.

    Devolve None quando não sobrou saldo — sem falta, sem pendência.

    Os itens ficam gravados com a quantidade e o preço do momento da decisão. É
    um retrato de propósito: quando o material chegar, o comercial precisa saber
    o que foi prometido, não o que o estoque diz hoje.
    """
    pendentes = disponibilidade_service.itens_pendentes(analise)
    if not pendentes:
        return None
    return {
        "decisao": decisao,
        "origem": origem,
        "decidido_em": _agora(),
        "decidido_por": usuario_id,
        "observacao": (observacao or "").strip() or None,
        "valor": round(sum(float(i.get("valor_pendente") or 0) for i in pendentes), 2),
        "itens": pendentes,
        "previsao_sa": analise.get("previsao_sa"),
        "cobre_com_sa": analise.get("cobre_com_sa"),
        "previsao_pcp": previsao_pcp,
        "resolvido_em": None,
        "resolucao": None,
    }


def analise_venda_inteira(analise: dict) -> dict:
    """A mesma análise, mas com a venda TODA marcada como pendente.

    Serve para "aguardar a produção" quando não existe outro lugar guardando o
    que foi vendido — caso da venda outbound, onde a OV nasce sem nenhum item e a
    pendência é a única memória do pedido. Gravar só o que faltava perderia os
    itens que tinham estoque: eles não entraram na OV (nada entrou) e não estariam
    na pendência para entrar depois.

    Na venda do CRM isto não é preciso: a oportunidade guarda os itens, e `liberar`
    os relê de crm_oportunidade_itens.
    """
    itens = []
    for i in (analise.get("itens") or []):
        qtd = float(i.get("qtd_pedida") or 0)
        vu = float(i.get("valor_unitario") or 0)
        itens.append({**i, "qtd_atendida": 0.0, "qtd_pendente": qtd,
                      "valor_pendente": round(qtd * vu, 2)})
    return {
        **analise,
        "itens": itens,
        "tem_falta": True,
        "tudo_disponivel": False,
        "qtd_pendente_total": round(sum(float(i["qtd_pendente"]) for i in itens), 2),
        "valor_pendente": round(sum(float(i["valor_pendente"]) for i in itens), 2),
    }


def somar_venda(pend: Optional[dict], vendidos: list, usuario_id: str,
                observacao: Optional[str] = None, previsao_pcp: Optional[str] = None) -> Optional[dict]:
    """Soma na pendência da OV material NOVO que acabou de ser vendido e não tem
    estoque para tudo.

    `vendidos`: [{produto_id, codigo, descricao, qtd_vendida, qtd_atendida,
    valor_unitario}] — `qtd_atendida` é o que entrou na OV agora; o resto é saldo.

    Diferente de `devolver_para_pendencia`: ali a venda já existia e o material só
    mudou de lugar, então `qtd_pedida` NÃO muda. Aqui houve venda nova, e
    `qtd_pedida` cresce junto com o pendente.

    Devolve a pendência atual (ou None) quando nada ficou faltando — vender com
    estoque para tudo não cria saldo.
    """
    faltantes = [v for v in vendidos
                 if float(v["qtd_vendida"]) - float(v.get("qtd_atendida") or 0) > 0.001]
    if not faltantes:
        return pend

    base = dict(pend) if pend else {
        "decisao": "PARCIAL",
        "origem": "ITEM_ADICIONADO",
        "decidido_em": _agora(),
        "decidido_por": usuario_id,
        "observacao": None,
        "valor": 0.0,
        "itens": [],
        "previsao_sa": None,
        "cobre_com_sa": False,
        "previsao_pcp": previsao_pcp,
        "resolvido_em": None,
        "resolucao": None,
    }
    itens = [dict(i) for i in (base.get("itens") or [])]
    por_produto = {i.get("produto_id"): i for i in itens if i.get("produto_id")}

    for v in faltantes:
        pid = str(v["produto_id"])
        vendida = float(v["qtd_vendida"])
        atendida = float(v.get("qtd_atendida") or 0)
        pendente = round(vendida - atendida, 3)
        vu = float(v.get("valor_unitario") or 0)
        alvo = por_produto.get(pid)
        if alvo is not None:
            # Mais material do mesmo item foi vendido: cresce o que foi pedido e
            # o que ficou devendo.
            alvo["qtd_pedida"] = round(float(alvo.get("qtd_pedida") or 0) + vendida, 3)
            alvo["qtd_atendida"] = round(float(alvo.get("qtd_atendida") or 0) + atendida, 3)
            alvo["qtd_pendente"] = round(float(alvo.get("qtd_pendente") or 0) + pendente, 3)
            alvo["valor_pendente"] = round(float(alvo["qtd_pendente"]) * (vu or float(alvo.get("valor_unitario") or 0)), 2)
            alvo["status"] = "FALTA"
        else:
            itens.append({
                "produto_id": pid,
                "codigo": v.get("codigo"),
                "descricao": v.get("descricao"),
                "qtd_pedida": vendida,
                "qtd_atendida": atendida,
                "qtd_pendente": pendente,
                "valor_unitario": vu,
                "valor_pendente": round(pendente * vu, 2),
                "disponivel": v.get("disponivel"),
                "estoque_sa": v.get("estoque_sa"),
                "reservado_antes": 0.0,
                "sem_dado": False,
                "cobre_com_sa": bool(v.get("cobre_com_sa")),
                "status": "SA" if v.get("cobre_com_sa") else "FALTA",
            })

    base["itens"] = itens
    base["valor"] = round(sum(float(i.get("valor_pendente") or 0) for i in itens), 2)
    # Entrou saldo novo: a pendência volta a estar aberta.
    base["resolvido_em"] = None
    base["resolucao"] = None
    if previsao_pcp and not base.get("previsao_pcp"):
        base["previsao_pcp"] = previsao_pcp
    if observacao:
        anterior = (base.get("observacao") or "").strip()
        base["observacao"] = f"{anterior} | {observacao}".strip(" |") if anterior else observacao
    return base


def devolver_para_pendencia(pend: Optional[dict], devolvidos: list,
                            usuario_id: str, observacao: Optional[str] = None) -> dict:
    """Soma na pendência da OV o material que ela devolveu ao estoque.

    `devolvidos`: [{produto_id, codigo, descricao, qtd, qtd_na_ov_antes,
    valor_unitario}] — `qtd` é o que saiu da OV agora.

    Por que somar aqui em vez de baixar um saldo de estoque: o comprometido é
    recalculado das OVs reais (ver docstring de estoque_service), então tirar o
    item da OV JÁ libera o estoque sozinho. O que não pode se perder é a dívida
    com o cliente — o material continua vendido. A pendência é onde ela mora, e
    daí sai como 2ª remessa quando houver material.

    Mantém o invariante do item: qtd_atendida + qtd_pendente == qtd_pedida. A
    quantidade VENDIDA não muda ao devolver — muda só onde ela está.
    """
    base = dict(pend) if pend else {
        "decisao": "PARCIAL",
        "origem": "DEVOLUCAO_ESTOQUE",
        "decidido_em": _agora(),
        "decidido_por": usuario_id,
        "observacao": None,
        "valor": 0.0,
        "itens": [],
        "previsao_sa": None,
        "cobre_com_sa": False,
        "previsao_pcp": None,
        "resolvido_em": None,
        "resolucao": None,
    }
    itens = [dict(i) for i in (base.get("itens") or [])]
    por_produto = {i.get("produto_id"): i for i in itens if i.get("produto_id")}

    for d in devolvidos:
        pid = str(d["produto_id"])
        qtd = float(d["qtd"])
        vu = float(d.get("valor_unitario") or 0)
        alvo = por_produto.get(pid)
        if alvo is not None:
            # Já havia saldo deste item: o devolvido sai do atendido e entra no
            # pendente. qtd_pedida não muda — a venda é a mesma.
            alvo["qtd_atendida"] = max(0.0, float(alvo.get("qtd_atendida") or 0) - qtd)
            alvo["qtd_pendente"] = round(float(alvo.get("qtd_pendente") or 0) + qtd, 3)
            alvo["valor_pendente"] = round(float(alvo["qtd_pendente"]) * vu, 2)
            alvo["status"] = "FALTA"
            # Parte do saldo agora é material que EXISTE (foi devolvido de
            # propósito), então não é falta esperando semiacabado.
            alvo["cobre_com_sa"] = False
        else:
            # Item que estava inteiro na OV, sem saldo nenhum: o que foi vendido
            # é o que estava na OV antes desta devolução.
            vendida = float(d.get("qtd_na_ov_antes") or qtd)
            itens.append({
                "produto_id": pid,
                "codigo": d.get("codigo"),
                "descricao": d.get("descricao"),
                "qtd_pedida": vendida,
                "qtd_atendida": max(0.0, vendida - qtd),
                "qtd_pendente": qtd,
                "valor_unitario": vu,
                "valor_pendente": round(qtd * vu, 2),
                "disponivel": None,
                "estoque_sa": None,
                "reservado_antes": 0.0,
                "sem_dado": False,
                "cobre_com_sa": False,
                "status": "FALTA",
            })

    base["itens"] = itens
    base["valor"] = round(sum(float(i.get("valor_pendente") or 0) for i in itens), 2)
    # Reabre a pendência: material voltou a ser devido.
    base["resolvido_em"] = None
    base["resolucao"] = None
    if observacao:
        anterior = (base.get("observacao") or "").strip()
        base["observacao"] = f"{anterior} | {observacao}".strip(" |") if anterior else observacao
    return base


# Como o saldo NASCEU. O titulo dizia "Venda outbound" para toda pendencia de
# pedido, o que passou a ser mentira: hoje elas vem de cinco caminhos, e so um e
# outbound. Quem le o card precisa saber de onde aquilo veio.
_TITULO_POR_ORIGEM = {
    "NOVA_OV": "Nova OV",
    "OUTBOUND": "Venda outbound",
    "EDICAO_ITENS": "Itens editados na OV",
    "ITEM_ADICIONADO": "Itens adicionados a OV",
    "DEVOLUCAO_ESTOQUE": "Material liberado da OV",
}

# Duas naturezas muito diferentes de saldo, que a tela tratava como uma so:
#
#   FALTA     o estoque nao tinha. Depende da producao — cobrar o PCP e esperar.
#   LIBERADO  o material EXISTIA e alguem escolheu nao prender nesta OV (liberou
#             a reserva, ou marcou "deixar livre" na decisao). Nao ha o que
#             cobrar do PCP: e decisao comercial, e pode voltar a qualquer hora.
#
# Misturar as duas faz o operador cobrar producao de material que esta na
# prateleira, e esperar por algo que so depende de decisao.
_MOTIVO_POR_ORIGEM = {"DEVOLUCAO_ESTOQUE": "LIBERADO"}


def natureza_do_saldo(origem: Optional[str]) -> str:
    """FALTA (o estoque nao tinha) ou LIBERADO (existia e foi solto de proposito)."""
    return _MOTIVO_POR_ORIGEM.get((origem or "").upper(), "FALTA")


def titulo_da_pendencia(origem: Optional[str], numero: Optional[str]) -> str:
    """So a origem, sem o numero: o card ja mostra a OV como link logo acima, e
    repetir dava "Nova OV OV016456"."""
    return _TITULO_POR_ORIGEM.get((origem or "").upper(), "Saldo da OV")


def _dias(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return max(0, (datetime.now(timezone.utc) - d).days)


def _acao(ov: Optional[dict], fonte: str = "oportunidade") -> tuple:
    """(acao, motivo_bloqueio) para a pendência cuja OV é `ov` (None = sem OV)."""
    if not ov:
        return "GERAR_OV", None
    status = ov.get("status")
    if status == "CANCELADO":
        if fonte == "pedido":
            # Venda outbound: a pendência mora na própria OV, então OV cancelada
            # é venda cancelada — não há saldo a entregar.
            return None, (f"A OV {ov.get('numero_pedido')} foi cancelada — a venda não existe "
                          "mais, então não há saldo para liberar.")
        # Venda do CRM: a OV cancelada é história. A venda segue de pé e o saldo
        # merece uma OV nova. Bloquear aqui deixava a pendência presa para sempre
        # a uma OV que ninguém vai mais usar.
        return "GERAR_OV", None
    if _provisorio(ov.get("numero_pedido")):
        # Operações de vendas ainda não completou o número real. Somar na mesma
        # OV é melhor do que criar remessa: o D365 não emitiu nada ainda.
        return "SOMAR_R1", None
    if status in _JA_SAIU:
        return "REMESSA_2", None
    return "SOMAR_R1", None


# ── Ordem da fila ─────────────────────────────────────────────────────────────
#
# Quando duas vendas querem o mesmo item e o material não dá para as duas, ALGUMA
# ordem decide quem recebe. O padrão é quem espera há mais tempo — é a regra que
# não precisa de ninguém para funcionar e não gera discussão.
#
# Mas o padrão não sabe o que o comercial sabe: que um cliente tem multa por
# atraso, que outro é o pedido que fecha o mês, que aquele terceiro já avisou que
# pode esperar. Daí a prioridade manual.
#
# `prioridade_fila` é um inteiro no jsonb da pendência (menor = primeiro). Sem
# valor, a pendência fica no bloco automático, atrás de todas as priorizadas.
#
# ESTA função é a fonte única da ordem: o rateio do estoque e a listagem usam a
# mesma. Duas ordenações diferentes fariam a tela mostrar uma fila e o material
# seguir outra — que é exatamente o tipo de divergência que ninguém descobre até
# alguém reclamar.

_SEM_PRIORIDADE = 10 ** 6


def _ordem_da_fila(pendencias: list) -> list:
    """As pendências na ordem em que o material é distribuído."""
    return sorted(
        pendencias,
        key=lambda p: (
            p.get("prioridade_fila") if p.get("prioridade_fila") is not None else _SEM_PRIORIDADE,
            -(p.get("dias_parada") or 0),
            # Desempate estável, para a ordem não dançar entre dois refreshes.
            str(p.get("id") or ""),
        ),
    )


def reordenar(ordem: list, usuario: UsuarioOut) -> dict:
    """Grava a prioridade manual da fila na ordem recebida.

    `ordem`: [{fonte, id}, ...] — a fila inteira, de cima para baixo.

    Grava só quem mudou de posição: reescrever tudo geraria movimentação repetida
    no histórico de OVs que ninguém mexeu.
    """
    db = get_service_db()
    agora = _agora()
    alterados = []

    for pos, item in enumerate(ordem or []):
        fonte = (item.get("fonte") or "").strip()
        rid = str(item.get("id") or "")
        if fonte not in ("oportunidade", "pedido") or not rid:
            raise HTTPException(status_code=400, detail="Fila com item inválido.")

        tabela = "crm_oportunidades" if fonte == "oportunidade" else "pedidos"
        rows = db.table(tabela).select("id, status, pendencia").eq("id", rid).execute().data
        if not rows:
            continue
        pend = rows[0].get("pendencia") or None
        if not pend or pend.get("resolvido_em"):
            continue
        if pend.get("prioridade_fila") == pos:
            continue

        nova = {**pend, "prioridade_fila": pos,
                "prioridade_por": str(usuario.id), "prioridade_por_nome": usuario.nome,
                "prioridade_em": agora}
        db.table(tabela).update({"pendencia": nova, "atualizado_em": agora}).eq("id", rid).execute()
        alterados.append({"fonte": fonte, "id": rid, "posicao": pos})
        _registrar_acompanhamento(
            db, fonte, rid, rows[0], usuario, None, None,
            f"prioridade na fila de material: {pos + 1}º", False)

    return {"ok": True, "alterados": alterados}


def ordem_automatica(usuario: UsuarioOut) -> dict:
    """Devolve a fila ao critério automático (quem espera mais, primeiro)."""
    db = get_service_db()
    agora = _agora()
    limpos = 0

    for fonte, tabela in (("oportunidade", "crm_oportunidades"), ("pedido", "pedidos")):
        try:
            rows = db.table(tabela).select("id, status, pendencia")\
                .not_is("pendencia", "null").execute().data
        except Exception:
            rows = []
        for r in rows:
            pend = r.get("pendencia") or None
            if not pend or pend.get("resolvido_em"):
                continue
            if pend.get("prioridade_fila") is None:
                continue
            nova = {k: v for k, v in pend.items()
                    if k not in ("prioridade_fila", "prioridade_por",
                                 "prioridade_por_nome", "prioridade_em")}
            db.table(tabela).update({"pendencia": nova, "atualizado_em": agora})\
                .eq("id", r["id"]).execute()
            limpos += 1
            _registrar_acompanhamento(db, fonte, r["id"], r, usuario, None, None,
                                      "fila voltou ao critério automático (tempo de espera)", False)

    return {"ok": True, "limpos": limpos}


# ── Listagem ──────────────────────────────────────────────────────────────────
def _ov_por_ids(db, ids: list) -> dict:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    out: dict = {}
    for i in range(0, len(ids), 40):
        rows = db.table("pedidos").select("id, numero_pedido, status, remessa_numero, cliente_id")\
            .in_("id", ids[i:i + 40]).execute().data
        for r in rows:
            out[r["id"]] = r
    return out


def _nomes_clientes(db, ids: list) -> dict:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    out: dict = {}
    for i in range(0, len(ids), 40):
        rows = db.table("clientes").select("id, nome").in_("id", ids[i:i + 40]).execute().data
        for r in rows:
            out[r["id"]] = r.get("nome")
    return out


def listar(incluir_resolvidas: bool = False) -> dict:
    """Todas as pendências abertas, dos dois fluxos, num formato só.

    Alimenta a coluna "Pendência de estoque" do kanban do CRM e a aba Pendências
    do Painel Comercial — a mesma verdade nas duas telas.
    """
    db = get_service_db()

    try:
        opps = db.table("crm_oportunidades").select(
            "id, titulo, cliente_id, canal, estagio, pendencia, gerado_ov_id, gerado_ov_ref, criado_em"
        ).eq("ativo", True).not_is("pendencia", "null").execute().data
    except Exception:
        # Migration v29 pendente: sem a coluna não há pendência para listar, e
        # devolver vazio é melhor do que derrubar o painel inteiro com 400.
        opps = []
    try:
        peds = db.table("pedidos").select(
            "id, numero_pedido, status, cliente_id, canal, pendencia, remessa_numero, criado_em"
        ).not_is("pendencia", "null").execute().data
    except Exception:
        peds = []

    ov_ids = [o.get("gerado_ov_id") for o in opps]
    ovs = _ov_por_ids(db, ov_ids)
    clientes = _nomes_clientes(
        db, [o.get("cliente_id") for o in opps] + [p.get("cliente_id") for p in peds])

    saida = []

    for o in opps:
        pend = o.get("pendencia") or {}
        if not incluir_resolvidas and pend.get("resolvido_em"):
            continue
        ov = ovs.get(o.get("gerado_ov_id"))
        acao, bloqueio = _acao(ov, "oportunidade")
        saida.append(_serializar(
            fonte="oportunidade", registro_id=o["id"], titulo=o.get("titulo"),
            cliente=clientes.get(o.get("cliente_id")), cliente_id=o.get("cliente_id"),
            canal=o.get("canal"), ov=ov, pend=pend, acao=acao, bloqueio=bloqueio,
            extra={"estagio": o.get("estagio"), "oportunidade_id": o["id"]}))

    for p in peds:
        pend = p.get("pendencia") or {}
        if not incluir_resolvidas and pend.get("resolvido_em"):
            continue
        acao, bloqueio = _acao(p, "pedido")
        saida.append(_serializar(
            fonte="pedido", registro_id=p["id"],
            titulo=titulo_da_pendencia((p.get("pendencia") or {}).get("origem"),
                                       p.get("numero_pedido")),
            cliente=clientes.get(p.get("cliente_id")), cliente_id=p.get("cliente_id"),
            canal=p.get("canal"), ov=p, pend=pend, acao=acao, bloqueio=bloqueio,
            extra={"oportunidade_id": None}))

    estoque = _estoque_agora(saida)

    # Posição de cada uma na fila do material — é a ordem que decide quem recebe
    # quando não dá para todos, e a tela precisa poder mostrá-la.
    for pos, x in enumerate(_ordem_da_fila(saida)):
        x["posicao_fila"] = pos + 1

    # Quem já tem material primeiro: a coluna existe para ser esvaziada, e o que
    # dá para liberar hoje é o que merece o olho do operador. Dentro de cada
    # grupo, maior valor primeiro — é onde o dinheiro parado está.
    ordem = {"COMPLETO": 0, "PARCIAL": 1, "NENHUM": 2}
    saida.sort(key=lambda x: (ordem.get((x.get("estoque_agora") or {}).get("status"), 3),
                              -(x.get("valor") or 0)))
    return {
        "pendencias": saida,
        "total": round(sum(x.get("valor") or 0 for x in saida), 2),
        "quantidade": len(saida),
        "aguardando": sum(1 for x in saida if x.get("decisao") == "AGUARDAR"),
        "parciais": sum(1 for x in saida if x.get("decisao") == "PARCIAL"),
        # Para o cabeçalho da coluna: quantas dá para resolver agora e quanto isso
        # destrava em dinheiro.
        "com_estoque": sum(1 for x in saida
                           if (x.get("estoque_agora") or {}).get("status") == "COMPLETO"),
        "com_estoque_parcial": sum(1 for x in saida
                                   if (x.get("estoque_agora") or {}).get("status") == "PARCIAL"),
        "valor_liberavel": round(sum((x.get("estoque_agora") or {}).get("valor_disponivel") or 0
                                     for x in saida), 2),
        "estoque_desatualizado": estoque.get("desatualizado", False),
        "estoque_data_ref": estoque.get("data_ref"),
        # Quantas foram posicionadas à mão: com zero, a fila é 100% automática.
        "priorizadas_a_mao": sum(1 for x in saida if x.get("prioridade_fila") is not None),
    }


def _estoque_agora(pendencias: list) -> dict:
    """Marca em cada pendência quanto do que falta JÁ existe em estoque hoje.

    Uma chamada só para todas as pendências, de propósito: `analisar` faz rateio
    sequencial, então a mesma unidade não é prometida a duas pendências. Item a
    item por pendência mostraria "chegou" nas duas e o segundo operador levaria
    um 409 na cara ao tentar liberar.

    A ordem do rateio vem de `_ordem_da_fila`: a prioridade manual primeiro, e
    depois quem espera há mais tempo. Mesma função que ordena a tela, senão a
    fila mostrada e a fila que recebe material seriam duas coisas diferentes.

    Não sincroniza com o PCP: esta é a listagem, tem que abrir na hora. Por isso
    devolve `desatualizado`, para a tela não afirmar "chegou" em cima de uma foto
    velha. Quem libera reconfere o estoque de verdade, com sincronização.
    """
    fila = _ordem_da_fila(pendencias)
    entrada = []
    for pos, p in enumerate(fila):
        # Nada entregue = falta a venda inteira. Medir contra o saldo diria
        # "chegou tudo" com 68 de 88 em estoque, porque só 34 estavam marcadas
        # como em falta no dia da decisão.
        campo = "qtd_pedida" if p.get("nada_entregue") else "qtd_pendente"
        for j, i in enumerate(p.get("itens") or []):
            if float(i.get(campo) or 0) <= 0:
                continue
            entrada.append({
                "ref": f"{pos}:{j}",
                "produto_id": i.get("produto_id"),
                "codigo": i.get("codigo"),
                "descricao": i.get("descricao"),
                "qtd": float(i.get(campo) or 0),
                "valor_unitario": float(i.get("valor_unitario") or 0),
            })

    if not entrada:
        for p in fila:
            p["estoque_agora"] = {"status": "NENHUM", "qtd_disponivel": 0.0,
                                  "valor_disponivel": 0.0, "itens_prontos": 0,
                                  "itens_total": len(p.get("itens") or []), "itens": []}
        return {"desatualizado": False, "data_ref": None}

    analise = disponibilidade_service.analisar(entrada, sincronizar=False)

    por_pendencia: dict = {}
    for item in analise.get("itens") or []:
        ref = str(item.get("ref") or "")
        if ":" not in ref:
            continue
        pos = int(ref.split(":")[0])
        por_pendencia.setdefault(pos, []).append(item)

    # Quem ficou com cada código, na ordem da fila. É o que transforma um "0 em
    # estoque" — que parece bug quando a tela de Estoque mostra 12 — em "as 12
    # unidades estão reservadas para a OV que está na frente".
    donos: dict = {}
    for pos, p in enumerate(fila):
        for item in por_pendencia.get(pos, []):
            q = float(item.get("qtd_atendida") or 0)
            if q <= 0:
                continue
            cod = (item.get("codigo") or "").strip().upper()
            donos.setdefault(cod, []).append({
                "pos": pos,
                "ov": p.get("ov_ref") or None,
                "cliente": p.get("cliente") or None,
                "qtd": round(q, 3),
            })

    for pos, p in enumerate(fila):
        itens = por_pendencia.get(pos, [])
        prontos = [i for i in itens if float(i.get("qtd_atendida") or 0) > 0]
        falta = any(float(i.get("qtd_pendente") or 0) > 0 for i in itens)
        qtd = sum(float(i.get("qtd_atendida") or 0) for i in itens)
        valor = sum(float(i.get("qtd_atendida") or 0) * float(i.get("valor_unitario") or 0)
                    for i in itens)
        status = "NENHUM" if not prontos else ("PARCIAL" if falta else "COMPLETO")
        p["estoque_agora"] = {
            "status": status,
            "qtd_disponivel": round(qtd, 3),
            "valor_disponivel": round(valor, 2),
            "itens_prontos": len(prontos),
            "itens_total": len(itens),
            # Só o que interessa por item, para a tela não recalcular nada.
            "itens": [{
                "codigo": i.get("codigo"),
                "qtd_atendida": float(i.get("qtd_atendida") or 0),
                "qtd_pendente": float(i.get("qtd_pendente") or 0),
                # Estoque do código como um todo, antes do rateio da fila.
                "disponivel": i.get("disponivel"),
                "reservado_antes": float(i.get("reservado_antes") or 0),
                # Quem está na frente segurando este código.
                "reservado_para": [d for d in donos.get((i.get("codigo") or "").strip().upper(), [])
                                   if d["pos"] < pos],
            } for i in itens],
        }

    return {"desatualizado": analise.get("desatualizado", False),
            "data_ref": analise.get("data_ref")}


def _serializar(fonte, registro_id, titulo, cliente, cliente_id, canal,
                ov, pend, acao, bloqueio, extra) -> dict:
    itens = pend.get("itens") or []

    # "aguardar produção" sem OV = NADA saiu. Nesse caso `qtd_atendida` do item é
    # o que HAVIA em estoque no dia da decisão, não o que foi entregue — e o que
    # está parado é a venda inteira, não só o que faltava.
    #
    # Sem esta distinção a tela dizia "entregue 54 de 88" de material que nunca
    # saiu, e o valor parado saía pela metade (contava as 34 em falta, não as 88
    # da venda). O total de dinheiro parado, somado, ficava menor do que é.
    nada_entregue = pend.get("decisao") == "AGUARDAR" and not ov
    if nada_entregue:
        qtd_parada = sum(float(i.get("qtd_pedida") or 0) for i in itens)
        valor_parado = round(sum(float(i.get("qtd_pedida") or 0) * float(i.get("valor_unitario") or 0)
                                 for i in itens), 2)
    else:
        qtd_parada = sum(float(i.get("qtd_pendente") or 0) for i in itens)
        valor_parado = round(float(pend.get("valor") or 0), 2)

    return {
        # A tela precisa saber se houve entrega para não escrever "entregue X".
        "nada_entregue": nada_entregue,
        "fonte": fonte,
        "id": registro_id,
        "titulo": titulo,
        "cliente": cliente,
        "cliente_id": cliente_id,
        "canal": canal,
        "ov_id": (ov or {}).get("id"),
        "ov_ref": (ov or {}).get("numero_pedido"),
        "ov_status": (ov or {}).get("status"),
        "ov_provisoria": _provisorio((ov or {}).get("numero_pedido")),
        "decisao": pend.get("decisao"),
        "origem": pend.get("origem"),
        # FALTA (o estoque nao tinha) x LIBERADO (existia e foi solto de
        # proposito). Muda o que o operador faz: LIBERADO nao se cobra do PCP.
        "natureza": natureza_do_saldo(pend.get("origem")),
        "valor": valor_parado,
        "qtd_total": round(qtd_parada, 3),
        "itens": itens,
        "previsao_sa": pend.get("previsao_sa"),
        "previsao_pcp": pend.get("previsao_pcp"),
        "cobre_com_sa": pend.get("cobre_com_sa"),
        "observacao": pend.get("observacao"),
        # Cada cobrança feita ao PCP, em ordem. É o que mostra "prometeram dia 10,
        # empurraram para 20" sem ninguém ter que lembrar.
        "acompanhamentos": pend.get("acompanhamentos") or [],
        # Posição manual na fila de material (menor = primeiro). None = automático.
        "prioridade_fila": pend.get("prioridade_fila"),
        "prioridade_por_nome": pend.get("prioridade_por_nome"),
        "prioridade_em": pend.get("prioridade_em"),
        "decidido_em": pend.get("decidido_em"),
        "dias_parada": _dias(pend.get("decidido_em")),
        "resolvido_em": pend.get("resolvido_em"),
        "resolucao": pend.get("resolucao"),
        "acao_liberar": acao,
        "pode_liberar": bool(acao),
        "motivo_bloqueio": bloqueio,
        **(extra or {}),
    }


# ── Acompanhamento ────────────────────────────────────────────────────────────
def acompanhar(fonte: str, registro_id: str, usuario: UsuarioOut,
               previsao_pcp: Optional[str] = None, observacao: Optional[str] = None,
               limpar_previsao: bool = False) -> dict:
    """Registra o que se descobriu sobre uma pendência: quando o material vem e
    o que o PCP respondeu.

    Antes, previsão e observação só podiam ser escritas no INSTANTE da decisão de
    estoque. Depois disso a pendência ficava muda: quem cobrava o PCP toda semana
    não tinha onde anotar, e a próxima pessoa recomeçava do zero — ou pior,
    cobrava de novo o que já tinha resposta.

    Cada cobrança entra em `acompanhamentos` (lista, não sobrescreve), então a
    pendência velha conta a própria história: quantas vezes foi cobrada, o que
    responderam, e quantas vezes a data prometida mudou.

    Não mexe em item, quantidade nem valor: isso é liberação, e tem função
    própria. Aqui é só o que se sabe sobre a espera.
    """
    if fonte not in ("oportunidade", "pedido"):
        raise HTTPException(status_code=400, detail="Origem de pendência inválida.")

    nota = (observacao or "").strip()
    prev = (previsao_pcp or "").strip() or None
    if not nota and not prev and not limpar_previsao:
        raise HTTPException(status_code=422,
                            detail="Informe uma previsão ou uma anotação — algo do que você apurou.")

    db = get_service_db()
    reg, pend = _ler(db, fonte, registro_id)
    agora = _agora()

    prev_antiga = pend.get("previsao_pcp")
    registro = {
        "em": agora,
        "por": str(usuario.id),
        "por_nome": usuario.nome,
        "observacao": nota or None,
        "previsao_pcp": prev,
        # Guardar a data ANTERIOR é o que revela promessa furada: três
        # acompanhamentos empurrando a data para frente contam essa história.
        "previsao_anterior": prev_antiga if (prev or limpar_previsao) else None,
    }

    nova = {**pend, "acompanhamentos": list(pend.get("acompanhamentos") or []) + [registro]}
    if limpar_previsao:
        nova["previsao_pcp"] = None
    elif prev:
        nova["previsao_pcp"] = prev
    if nota:
        # `observacao` é o texto que as telas mostram: fica o mais recente, e o
        # histórico completo continua em `acompanhamentos`.
        nova["observacao"] = nota

    db.table("crm_oportunidades" if fonte == "oportunidade" else "pedidos")\
        .update({"pendencia": nova, "atualizado_em": agora}).eq("id", registro_id).execute()

    _registrar_acompanhamento(db, fonte, registro_id, reg, usuario, prev, prev_antiga,
                              nota, limpar_previsao)
    return {"ok": True, "pendencia": nova}


def _registrar_acompanhamento(db, fonte: str, registro_id: str, reg: dict,
                              usuario: UsuarioOut, prev: Optional[str],
                              prev_antiga: Optional[str], nota: str,
                              limpou: bool) -> None:
    """Deixa a cobrança no histórico que a pessoa já lê (evento do CRM ou
    movimentação da OV). Best-effort: anotar não pode falhar por causa do log."""
    partes = []
    if limpou:
        partes.append("previsão removida")
    elif prev and prev != prev_antiga:
        partes.append(f"previsão {'alterada de ' + str(prev_antiga)[:10] + ' para ' if prev_antiga else 'definida para '}{prev}")
    if nota:
        partes.append(nota)
    texto = "📦 Pendência de estoque — " + (" · ".join(partes) or "acompanhada")

    try:
        if fonte == "oportunidade":
            from app.services import crm_service
            crm_service._log_evento(db, registro_id, texto, str(usuario.id))
        else:
            from app.services import pedido_service
            status = reg.get("status")
            pedido_service._registrar_movimentacao(registro_id, status, status,
                                                  str(usuario.id), texto)
    except Exception:
        pass


# ── Liberação ─────────────────────────────────────────────────────────────────
def _ler(db, fonte: str, registro_id: str) -> tuple:
    """(registro, pendencia). Erra alto se não houver pendência aberta."""
    tabela = "crm_oportunidades" if fonte == "oportunidade" else "pedidos"
    rows = db.table(tabela).select("*").eq("id", registro_id).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="Registro não encontrado.")
    reg = rows[0]
    pend = reg.get("pendencia") or None
    if not pend:
        raise HTTPException(status_code=404, detail="Este registro não tem pendência de estoque.")
    if pend.get("resolvido_em"):
        raise HTTPException(status_code=409, detail="Esta pendência já foi liberada.")
    return reg, pend


def liberar(fonte: str, registro_id: str, usuario: UsuarioOut,
            parcial: bool = False, observacao: Optional[str] = None,
            itens_escolhidos: Optional[list] = None) -> dict:
    """Manda o saldo para a expedição, agora que existe material.

    Confere o estoque OUTRA VEZ antes de liberar. Sem isso o app repetiria o erro
    que esta feature existe para evitar: prometer material que não está lá — a
    pendência pode ter ficado dias parada e outra OV pode ter consumido a
    produção nesse meio tempo.

    `parcial=True` libera só o que já dá e mantém o resto pendente.
    """
    from app.models.schemas import ItemPedidoCreate, PedidoCreate
    from app.services import pedido_service

    if fonte not in ("oportunidade", "pedido"):
        raise HTTPException(status_code=400, detail="Origem de pendência inválida.")

    db = get_service_db()
    reg, pend = _ler(db, fonte, registro_id)
    itens_pend = pend.get("itens") or []
    if not itens_pend:
        raise HTTPException(status_code=422, detail="A pendência não tem itens para liberar.")

    ov = None
    if fonte == "oportunidade":
        if reg.get("gerado_ov_id"):
            ov = (_ov_por_ids(db, [reg["gerado_ov_id"]]) or {}).get(reg["gerado_ov_id"])
    else:
        ov = reg
    acao, bloqueio = _acao(ov, fonte)
    if not acao:
        raise HTTPException(status_code=409, detail=bloqueio)
    # OV cancelada numa venda do CRM: abre uma nova em vez de tentar derivar dela.
    if acao == "GERAR_OV" and fonte == "oportunidade" and ov and ov.get("status") == "CANCELADO":
        ov = None

    # ── O que ainda falta ENTREGAR ────────────────────────────────────────────
    # Não é sempre o saldo. Depende de já ter saído OV ou não:
    #
    #   "aguardar produção" e sem OV  →  nada foi entregue, então falta entregar a
    #                                    VENDA INTEIRA, não só o item que faltava.
    #   qualquer outro caso           →  a OV já levou o que havia; falta o saldo.
    #
    # Usar sempre o saldo (era o que fazia) tornava invisível qualquer item
    # acrescentado depois do ganho: a venda tinha 100 un de um item COM estoque
    # esperando junto, e liberar não entregava nada além do item em falta.
    nada_entregue = pend.get("decisao") == "AGUARDAR" and not ov
    if nada_entregue and fonte == "oportunidade":
        itens_entrada = disponibilidade_service.entrada_de_itens_crm(
            db.table("crm_oportunidade_itens").select("*")
            .eq("oportunidade_id", registro_id).order("id").execute().data)
    else:
        itens_entrada = [{
            "ref": idx,
            "produto_id": i.get("produto_id"),
            "codigo": i.get("codigo"),
            "descricao": i.get("descricao"),
            "qtd": float(i.get("qtd_pendente") or 0),
            "valor_unitario": float(i.get("valor_unitario") or 0),
        } for idx, i in enumerate(itens_pend)]

    # ── Reconfere o estoque ───────────────────────────────────────────────────
    analise = disponibilidade_service.analisar(itens_entrada, sincronizar=True)

    if analise.get("tem_falta") and not parcial:
        raise HTTPException(status_code=409, detail={
            "tipo": "ESTOQUE_INSUFICIENTE",
            "msg": "Ainda não há material para tudo. Libere para operações de vendas o que "
                   "já tem em estoque — o resto continua pendente.",
            "analise": analise,
        })

    a_liberar = disponibilidade_service.itens_atendidos(analise)
    if not a_liberar:
        raise HTTPException(status_code=409, detail={
            "tipo": "ESTOQUE_INSUFICIENTE",
            "msg": "Nenhuma unidade disponível ainda — não há o que liberar.",
            "analise": analise,
        })

    # ── O comercial pode escolher quanto de cada item vai agora ───────────────
    # Sem a lista, sai tudo o que há em estoque (como era). Com ela, respeita a
    # escolha — mas nunca acima do que existe: o estoque acabou de ser reconferido
    # e prometer mais do que tem é o erro que este fluxo inteiro existe para evitar.
    if itens_escolhidos is not None:
        pedido_por_produto: dict = {}
        for e in itens_escolhidos:
            pid = str(getattr(e, "produto_id", None) or (e.get("produto_id") if isinstance(e, dict) else ""))
            qtd = float(getattr(e, "qtd", None) if not isinstance(e, dict) else e.get("qtd") or 0)
            if pid and qtd > 0:
                pedido_por_produto[pid] = pedido_por_produto.get(pid, 0.0) + qtd

        escolhidos = []
        for i in a_liberar:
            pid = str(i.get("produto_id") or "")
            if pid not in pedido_por_produto:
                continue  # o comercial deixou este item para depois
            disponivel = float(i.get("qtd_atendida") or 0)
            querido = pedido_por_produto[pid]
            if querido > disponivel + 0.001:
                raise HTTPException(status_code=422, detail=(
                    f"Pedido {querido:g} un de {i.get('codigo') or 'um item'}, mas só há "
                    f"{disponivel:g} em estoque agora."))
            escolhidos.append({**i, "qtd_atendida": querido,
                               "qtd_pendente": float(i.get("qtd_pedida") or 0) - querido})
        if not escolhidos:
            raise HTTPException(status_code=422,
                                detail="Escolha ao menos um item (com quantidade) para liberar.")
        a_liberar = escolhidos

    itens_ov = [ItemPedidoCreate(
        produto_id=i["produto_id"],
        qtd_solicitada=float(i["qtd_atendida"]),
        valor_unitario=float(i.get("valor_unitario") or 0) or None,
    ) for i in a_liberar if i.get("produto_id")]
    if not itens_ov:
        raise HTTPException(
            status_code=422,
            detail="Os itens da pendência não têm produto cadastrado — não dá para gerar a remessa.")

    resultado_ov = None
    if acao == "REMESSA_2":
        resultado_ov = pedido_service.criar_pedido(PedidoCreate(
            numero_pedido=ov["numero_pedido"],
            cliente_id=reg.get("cliente_id") or ov.get("cliente_id"),
            data_prevista_entrega=_hoje_brt() + timedelta(days=7),
            # Mesma venda, segunda remessa: a condição é a que já foi negociada na
            # OV original — não faz sentido perguntar de novo. As OVs antigas não
            # têm o campo, daí o fallback.
            condicao_pagamento=(ov.get("condicao_pagamento") or "—").strip() or "—",
            # A remessa é a mesma venda: herda direta/licitação da OV original,
            # senão a 2ª remessa de uma licitação seria rotulada como direta.
            forma_venda=ov.get("forma_venda"),
            canal=ov.get("canal"),
            itens=itens_ov,
            criar_derivada=True,
            observacoes=f"Remessa do saldo que estava pendente de estoque. {observacao or ''}".strip(),
        ), usuario)
    elif acao == "SOMAR_R1":
        resultado_ov = _somar_na_ov(db, ov, a_liberar, usuario)
        # A OV pode ter nascido sem item (aguardando produção): o rótulo da linha
        # só dá para calcular agora que os itens entraram.
        pedido_service._sincronizar_linha(db, ov["id"], ov.get("forma_venda"))
        # Venda outbound que estava aguardando a produção: agora tem material e
        # itens, então entra no kanban da expedição, na coluna "Dados da OV" —
        # é lá que operações de vendas informa o número real do D365.
        if ov.get("status") == StatusPedido.AGUARD_PRODUCAO.value:
            db.table("pedidos").update({
                "status": StatusPedido.AGUARD_DADOS_OV.value, "atualizado_em": _agora(),
            }).eq("id", ov["id"]).execute()
            pedido_service._registrar_movimentacao(
                ov["id"], StatusPedido.AGUARD_PRODUCAO.value, StatusPedido.AGUARD_DADOS_OV.value,
                str(usuario.id), "Material chegou — a venda entrou na expedição.")
    else:  # GERAR_OV
        resultado_ov = _gerar_ov_do_saldo(db, reg, a_liberar, usuario)

    # ── Baixa (ou reduz) a pendência ──────────────────────────────────────────
    # O que fica pendente é o pedido MENOS o que acabou de sair — e não o que a
    # análise achou em falta. Com escolha item a item, o comercial pode liberar
    # menos do que havia em estoque (ou pular um item), e essa diferença tem que
    # continuar pendente em vez de sumir junto com a baixa.
    saiu_por_produto: dict = {}
    for i in a_liberar:
        pid = str(i.get("produto_id") or "")
        if pid:
            saiu_por_produto[pid] = saiu_por_produto.get(pid, 0.0) + float(i.get("qtd_atendida") or 0)

    restante = []
    for i in (analise.get("itens") or []):
        pid = str(i.get("produto_id") or "")
        falta = float(i.get("qtd_pedida") or 0) - saiu_por_produto.get(pid, 0.0)
        if falta > 0.001:
            vu = float(i.get("valor_unitario") or 0)
            restante.append({**i, "qtd_atendida": saiu_por_produto.get(pid, 0.0),
                             "qtd_pendente": round(falta, 3),
                             "valor_pendente": round(falta * vu, 2)})
    agora = _agora()
    if restante:
        # Liberação parcial: o que ainda falta continua pendente, com o valor
        # recalculado. A pendência não pode "desaparecer" com saldo aberto.
        nova = {**pend,
                "itens": restante,
                "valor": round(sum(float(i.get("valor_pendente") or 0) for i in restante), 2),
                "liberado_parcial_em": agora}
    else:
        nova = {**pend, "resolvido_em": agora, "resolucao": acao,
                "resolvido_por": str(usuario.id)}

    tabela = "crm_oportunidades" if fonte == "oportunidade" else "pedidos"
    db.table(tabela).update({"pendencia": nova, "atualizado_em": agora}).eq("id", registro_id).execute()

    return {
        "ok": True,
        "acao": acao,
        "ov": resultado_ov,
        "liberados": a_liberar,
        "ainda_pendente": restante,
        "pendencia": nova,
    }


def _somar_na_ov(db, ov: dict, itens: list, usuario: UsuarioOut) -> dict:
    """Aumenta a quantidade na própria OV, que ainda não saiu.

    Nada foi expedido nem faturado, então uma nota cobre tudo — criar remessa
    aqui só geraria duas notas para uma entrega só.
    """
    from app.services import pedido_service

    atuais = db.table("itens_pedido").select("id, produto_id, qtd_solicitada")\
        .eq("pedido_id", ov["id"]).execute().data
    por_produto: dict = {}
    for it in atuais:
        por_produto.setdefault(it.get("produto_id"), []).append(it)

    somados = []
    for i in itens:
        pid = i.get("produto_id")
        add = float(i.get("qtd_atendida") or 0)
        if not pid or add <= 0:
            continue
        existentes = por_produto.get(pid) or []
        if existentes:
            linha = existentes[0]
            nova_qtd = float(linha.get("qtd_solicitada") or 0) + add
            db.table("itens_pedido").update({"qtd_solicitada": nova_qtd}).eq("id", linha["id"]).execute()
        else:
            db.table("itens_pedido").insert({
                "pedido_id": ov["id"], "produto_id": pid,
                "qtd_solicitada": add,
                "valor_unitario": float(i.get("valor_unitario") or 0) or None,
                "status_item": "PENDENTE",
            }).execute()
        somados.append(f"{i.get('codigo') or pid} +{add:g}")

    from app.services.inventario_service import _get_usuario_real
    uid = _get_usuario_real(str(usuario.id))
    pedido_service._registrar_movimentacao(
        ov["id"], ov.get("status"), ov.get("status"), uid,
        "Saldo que estava pendente de estoque somado a esta OV (a OV ainda não "
        f"faturou, então segue em uma nota só): {', '.join(somados)}")
    return {"id": ov["id"], "numero_pedido": ov.get("numero_pedido"),
            "somado": somados, "remessa_numero": ov.get("remessa_numero") or 1}


def _gerar_ov_do_saldo(db, oportunidade: dict, itens: list, usuario: UsuarioOut) -> dict:
    """Decisão foi "aguardar produção": não havia OV nenhuma. O material chegou,
    então a OV nasce agora — no mesmo card do kanban em que toda venda ganha do
    CRM entra (AGUARD_DADOS_OV, esperando o número real do D365)."""
    from app.services import pedido_service

    stub = pedido_service.criar_pedido_stub_crm(
        oportunidade,
        [{"produto_id": i.get("produto_id"), "qtd": float(i.get("qtd_atendida") or 0),
          "valor_unitario": i.get("valor_unitario")} for i in itens],
        str(usuario.id))
    db.table("crm_oportunidades").update({
        "gerado_ov_id": stub["id"], "gerado_ov_ref": stub["numero_pedido"],
        "atualizado_em": _agora(),
    }).eq("id", oportunidade["id"]).execute()
    return stub
