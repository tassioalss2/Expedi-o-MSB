"""Tela de início: a barra de meta (fixa em todas as telas) e as pendências.

Duas responsabilidades, dois endpoints, porque têm custos muito diferentes:

`barra_meta()` roda em TODA navegação (o Layout a mantém no topo de qualquer
tela), então precisa ser barata: lê só o faturamento do mês e a meta.

`pendencias()` roda apenas na tela de início e pode varrer mais coisa.

Nada aqui recalcula regra de negócio própria: o realizado sai do mesmo
`outras_vendas.faturamento_sem_frete` que o Painel Comercial usa (senão a barra
mostraria um número e o painel outro), e o risco de multa vem do helper
compartilhado em licitacao_demanda_service.
"""
from datetime import date, datetime, timedelta, timezone

from app.core.database import get_service_db
from app.services import licitacao_demanda_service

_BRT = timezone(timedelta(hours=-3))

# Status em que a OV ainda está viva no fluxo (não faturou nem foi cancelada).
_STATUS_ABERTOS = [
    "AGUARD_CREDITO", "LIBERADO", "EM_INVENTARIO", "AGUARD_VERIFICACAO",
    "DIVERGENCIA", "AGUARD_TRATATIVA", "EM_PROCESSO_SISTEMICO",
    "EM_COTACAO_FRETE", "AGUARD_TRANSPORTADORA", "AGUARD_FATURAMENTO",
    "BLOQUEADO",
]
_ETAPAS_FINAIS = {"NF_ENVIADA", "CONCLUIDO"}

# Tolerância do "no ritmo": abaixo do esperado, mas dentro disso, ainda não é
# alarme — o faturamento é irregular dentro do mês (concentra no fim).
_TOLERANCIA_RITMO = 10.0


def _hoje_brt() -> date:
    return datetime.now(_BRT).date()


def _dias_uteis(ini: date, fim: date) -> int:
    """Dias úteis no intervalo, inclusive. Sem feriados — a barra é indicativa e
    um feriado não muda a leitura de "atrás/no ritmo"."""
    dias, d = 0, ini
    while d <= fim:
        if d.weekday() < 5:
            dias += 1
        d += timedelta(days=1)
    return dias


def _ultimo_dia_do_mes(d: date) -> date:
    return date(d.year + (d.month == 12), (d.month % 12) + 1, 1) - timedelta(days=1)


def _uteis_do_mes(hoje: date) -> tuple:
    """(dias úteis do mês, dias úteis até hoje inclusive)."""
    primeiro = date(hoje.year, hoje.month, 1)
    return _dias_uteis(primeiro, _ultimo_dia_do_mes(hoje)), _dias_uteis(primeiro, hoje)


def _ritmo(pct_realizado: float, hoje: date) -> dict:
    """Onde deveríamos estar hoje, pela fração de dias úteis já decorrida."""
    uteis_total, uteis_ate_hoje = _uteis_do_mes(hoje)
    pct_esperado = round(uteis_ate_hoje / uteis_total * 100, 1) if uteis_total else 0.0

    if pct_realizado >= 100:
        status, rotulo = "BATIDA", "meta batida"
    elif pct_realizado >= pct_esperado:
        status, rotulo = "NO_RITMO", "no ritmo"
    elif pct_realizado >= pct_esperado - _TOLERANCIA_RITMO:
        status, rotulo = "POUCO_ATRAS", "um pouco atrás do ritmo"
    else:
        status, rotulo = "ATRAS", "atrás do ritmo"
    return {
        "pct_esperado": pct_esperado,
        "status": status,
        "rotulo": rotulo,
        # HOJE conta como dia disponível: o dia não acabou, ainda dá para faturar
        # nele. É a mesma contagem da Previsão de Faturamento (_dias_uteis(hoje,
        # fim)) — antes eu excluía hoje e a barra dizia 2 onde a Previsão dizia 3.
        "dias_uteis_restantes": _dias_uteis(hoje, _ultimo_dia_do_mes(hoje)),
    }


def barra_meta() -> dict:
    """Faturamento do mês e do dia vs meta — a barra fixa do topo, em todas as telas.

    Mês e dia saem da MESMA função com intervalos diferentes, de propósito: se um
    usasse `faturamento_diario` (que exclui Esterilize) e o outro `outras_vendas`
    (que não exclui), num mês com Esterilize a própria barra se contradiria.
    """
    # Import local: o módulo de pedidos importa serviços, e importar no topo daqui
    # fecharia um ciclo.
    from app.api.pedidos import dashboard_financeiro
    from app.services import pedido_service

    hoje = _hoje_brt()
    inicio = date(hoje.year, hoje.month, 1)
    competencia = hoje.strftime("%Y-%m")

    def _vendas(ini: date, fim: date) -> tuple:
        fin = dashboard_financeiro(data_inicio=ini, data_fim=fim, _=None)
        ov = fin.get("outras_vendas") or {}
        return float(ov.get("faturamento_sem_frete") or 0), int(ov.get("qtd_nfs") or 0)

    realizado, _qtd_mes = _vendas(inicio, hoje)
    # Intervalo de um dia: consulta estreita, barata o suficiente para a barra
    # que roda em toda navegação.
    realizado_hoje, nfs_hoje = _vendas(hoje, hoje)

    meta = pedido_service.obter_meta(competencia)
    valor_meta = meta.get("valor")
    pct = round(realizado / valor_meta * 100, 1) if valor_meta else 0.0
    falta = round(max(0.0, (valor_meta or 0) - realizado), 2)

    dia = None
    if valor_meta:
        restantes = _ritmo(pct, hoje)["dias_uteis_restantes"]
        # Alvo do dia = ritmo p/ bater a meta (falta ÷ dias úteis restantes), o
        # MESMO número da Previsão de Faturamento. Antes aqui era a média
        # achatada do mês (meta ÷ dias úteis totais), que com o mês atrasado dá
        # ~1/3 do que o dia realmente precisa entregar — a barra dizia "1% da
        # diária" de um alvo que já não valia mais.
        alvo = round(falta / restantes, 2) if restantes and falta else 0.0
        dia = {
            "data": hoje.isoformat(),
            "realizado": round(realizado_hoje, 2),
            "nfs": nfs_hoje,
            "alvo": alvo,
            "pct": round(realizado_hoje / alvo * 100, 1) if alvo else 100.0,
            "dias_uteis_restantes": restantes,
            "eh_dia_util": hoje.weekday() < 5,
        }

    return {
        "competencia": competencia,
        "realizado": round(realizado, 2),
        "meta": valor_meta,
        "pct": pct,
        "falta": falta,
        "ritmo": _ritmo(pct, hoje) if valor_meta else None,
        "dia": dia,
    }


def _pendencia(chave, titulo, detalhe, qtd, para, acao, gravidade) -> dict:
    return {"chave": chave, "titulo": titulo, "detalhe": detalhe, "qtd": qtd,
            "para": para, "acao": acao, "gravidade": gravidade}


def pendencias() -> dict:
    """O que precisa de ação agora, das fontes reais do app.

    Só entra o que tem contagem > 0: a tela mostra a lista do dia, não um
    checklist de zeros — se está tudo em ordem, a seção some.
    """
    db = get_service_db()
    hoje = _hoje_brt()
    hoje_iso = hoje.isoformat()
    itens: list[dict] = []

    # 1) OVs atrasadas — prazo de entrega estourado com a OV ainda em aberto.
    try:
        peds = db.table("pedidos").select("numero_pedido, data_prevista_entrega, clientes(nome)")\
            .in_("status", _STATUS_ABERTOS).lte("data_prevista_entrega", hoje_iso).execute().data
        atrasadas = [p for p in peds if (p.get("data_prevista_entrega") or "") < hoje_iso]
        if atrasadas:
            atrasadas.sort(key=lambda p: p.get("data_prevista_entrega") or "")
            pior = atrasadas[0]
            dias = (hoje - date.fromisoformat(pior["data_prevista_entrega"])).days
            cliente = (pior.get("clientes") or {}).get("nome") or "—"
            detalhe = (f"{pior.get('numero_pedido')} há {dias} dia{'s' if dias > 1 else ''} · {cliente}"
                       if len(atrasadas) == 1
                       else f"a mais antiga: {pior.get('numero_pedido')} há {dias} dia{'s' if dias > 1 else ''}")
            itens.append(_pendencia(
                "ovs_atrasadas",
                f"{len(atrasadas)} OV{'s' if len(atrasadas) > 1 else ''} atrasada{'s' if len(atrasadas) > 1 else ''}",
                detalhe, len(atrasadas), "/dashboard", "Resolver", "ALTA"))
    except Exception:
        pass

    # 2) Demandas sem estoque — separa as em risco de multa (previsão do PCP
    #    estoura o prazo contratual) das que só estão esperando material.
    try:
        dem = db.table("licitacao_demandas").select("numero, etapa, prazo, estoque, criado_em, clientes(nome)")\
            .eq("ativo", True).execute().data
        aguardando = [d for d in dem if d.get("etapa") == "AGUARDANDO_ESTOQUE"]
        em_risco = [d for d in aguardando
                    if licitacao_demanda_service.risco_multa_estoque(d, hoje_iso)]
        if em_risco:
            itens.append(_pendencia(
                "estoque_risco_multa",
                f"{len(em_risco)} demanda{'s' if len(em_risco) > 1 else ''} sem estoque com risco de multa",
                "a previsão do PCP estoura o prazo contratual",
                len(em_risco), "/licitacoes", "Ver", "ALTA"))
        restantes = len(aguardando) - len(em_risco)
        if restantes > 0:
            itens.append(_pendencia(
                "estoque_aguardando",
                f"{restantes} demanda{'s' if restantes > 1 else ''} aguardando estoque",
                "esperando material do PCP, prazo ainda folgado",
                restantes, "/licitacoes", "Ver", "MEDIA"))

        # 3) Demandas paradas há 2+ dias na triagem (AGUARDANDO_ESTOQUE está
        #    parado de propósito, então fica fora — mesma regra do resumo Teams).
        limite = datetime.now(timezone.utc) - timedelta(days=2)
        paradas = []
        for d in dem:
            if d.get("etapa") in _ETAPAS_FINAIS or d.get("etapa") == "AGUARDANDO_ESTOQUE":
                continue
            try:
                criado = datetime.fromisoformat((d.get("criado_em") or "").replace("Z", "+00:00"))
            except Exception:
                continue
            if criado <= limite:
                paradas.append((datetime.now(timezone.utc) - criado).days)
        if paradas:
            itens.append(_pendencia(
                "demandas_paradas",
                f"{len(paradas)} demanda{'s' if len(paradas) > 1 else ''} parada{'s' if len(paradas) > 1 else ''} na triagem",
                f"há {max(paradas)} dias sem andar, a mais antiga",
                len(paradas), "/licitacoes", "Triar", "MEDIA"))
    except Exception:
        pass

    # 4) Ocorrências abertas.
    try:
        oc = db.table("ocorrencias").select("id").eq("status", "ABERTA").execute().data
        if oc:
            itens.append(_pendencia(
                "ocorrencias",
                f"{len(oc)} ocorrência{'s' if len(oc) > 1 else ''} aberta{'s' if len(oc) > 1 else ''}",
                "sem tratativa registrada", len(oc), "/ocorrencias", "Tratar", "MEDIA"))
    except Exception:
        pass

    # 5) OVs novas aguardando entrar na expedição.
    try:
        lib = db.table("pedidos").select("id").eq("status", "LIBERADO").execute().data
        if lib:
            itens.append(_pendencia(
                "ovs_liberadas",
                f"{len(lib)} OV{'s' if len(lib) > 1 else ''} aguardando expedição",
                "liberada, ainda não entrou no fluxo", len(lib), "/expedicao", "Abrir", "BAIXA"))
    except Exception:
        pass

    # 6) Vendas ganhas que ficaram sem OV — ANOMALIA, não fila de trabalho.
    #    No fluxo de três saídas do ganho, ou a OV nasce em "Dados da OV", ou a
    #    venda está na coluna Pendência esperando material (essas não entram aqui,
    #    ver crm_service.ganhas_sem_ov). Sobrar algo significa que a criação da OV
    #    falhou — merece alarme, não uma fila para alguém trabalhar.
    try:
        from app.services import crm_service
        fila = crm_service.ganhas_sem_ov(db)
        if fila:
            n = len(fila)
            mais_antiga = max((f["dias_esperando"] for f in fila), default=0)
            detalhe = ("a OV deveria ter sido aberta junto com o ganho"
                       + (f" · parada há {mais_antiga} dia{'s' if mais_antiga > 1 else ''}"
                          if mais_antiga > 0 else ""))
            itens.append(_pendencia(
                "ganhas_sem_ov",
                f"{n} venda{'s' if n > 1 else ''} ganha{'s' if n > 1 else ''} sem OV",
                detalhe, n, "/crm", "Abrir o funil",
                "ALTA" if mais_antiga >= 1 else "MEDIA"))
    except Exception:
        pass

    # 7) Canal comercial atrás do ritmo do mês.
    try:
        itens += _canais_atras_do_ritmo(hoje)
    except Exception:
        pass

    ordem = {"ALTA": 0, "MEDIA": 1, "BAIXA": 2}
    itens.sort(key=lambda i: (ordem.get(i["gravidade"], 9), -i["qtd"]))
    return {"itens": itens, "data_ref": hoje_iso}


def _canais_atras_do_ritmo(hoje: date) -> list:
    """Canais cuja venda no mês está abaixo do ritmo esperado para hoje.

    Comparado contra a meta DO CANAL (não a rateada do total): é a meta que o
    time do canal recebeu, é por ela que ele é cobrado.
    """
    from app.api.pedidos import vendas_por_canal
    from app.services import pedido_service

    inicio = date(hoje.year, hoje.month, 1)
    meta = pedido_service.obter_meta(hoje.strftime("%Y-%m"))
    por_canal = meta.get("por_canal") or {}
    if not any(por_canal.values()):
        return []

    resp = vendas_por_canal(data_inicio=inicio, data_fim=hoje, _=None)
    realizado = {c["canal"]: float(c["valor"] or 0) for c in (resp.get("canais") or [])}
    esperado = _ritmo(0, hoje)["pct_esperado"]

    fora = []
    for canal, alvo in por_canal.items():
        if not alvo:
            continue
        pct = round(realizado.get(canal, 0.0) / float(alvo) * 100, 1)
        if pct >= esperado - _TOLERANCIA_RITMO:
            continue
        fora.append((pct, canal))

    fora.sort()
    rotulos = {"URO": "Uro", "VASCULAR": "Vascular", "REALCLOSURE": "Realclosure", "LICITACAO": "Licitação"}
    return [_pendencia(
        f"canal_{canal.lower()}",
        f"Canal {rotulos.get(canal, canal)} em {pct:.0f}% da meta",
        f"o ritmo esperado para hoje é {esperado:.0f}%",
        1, "/comercial#canais", "Ver", "MEDIA",
    ) for pct, canal in fora]
