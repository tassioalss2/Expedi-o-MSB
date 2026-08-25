"""Painel de demandas de licitação — triagem visual (Kanban) das operações que
chegam por e-mail (venda direta, consignação, comunicado de uso).

Cada demanda é um card que anda pelas etapas NOVO → ANALISE → PROCESSANDO →
CONCLUIDO. Ao concluir, o app gera automaticamente o artefato correspondente:
- VENDA_DIRETA  → cria a OV no fluxo logístico
- CONSIGNACAO   → cria o empenho
- COMUNICADO_USO→ registra o comunicado de uso (baixando saldo de um empenho, se houver)
"""
from datetime import date
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import (
    ComunicadoUsoCreate,
    ConsumoEmpenhoCreate,
    DemandaConcluir,
    DemandaCreate,
    DemandaUpdate,
    EmpenhoCreate,
    EmpenhoItemCreate,
    ItemPedidoCreate,
    PedidoCreate,
    UsuarioOut,
)

ETAPAS = ["RECEBIDO", "PROCESSANDO", "AGUARDANDO_ESTOQUE", "COTACAO_FRETE", "OV_GERADA", "NF_ENVIADA", "CONCLUIDO"]
# Etapas antigas → novas (compatibilidade com registros já criados)
_ETAPA_LEGADA = {"NOVO": "RECEBIDO", "ANALISE": "RECEBIDO"}
# Etapas terminais (saem do painel do dia seguinte, vão para o histórico)
ETAPAS_FINAIS = {"NF_ENVIADA", "CONCLUIDO"}
TIPOS = ["VENDA_DIRETA", "CONSIGNACAO", "COMUNICADO_USO"]
_PRIORIDADE_PESO = {"CRITICA": 0, "ALTA": 1, "NORMAL": 2}


def _agora() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _hoje_brt() -> str:
    """Data de hoje no fuso de Brasília (YYYY-MM-DD)."""
    from datetime import datetime, timezone, timedelta
    return datetime.now(timezone(timedelta(hours=-3))).date().isoformat()


def _data_brt(iso: Optional[str]) -> str:
    """Converte um timestamp ISO (UTC) para a data no fuso de Brasília."""
    if not iso:
        return ""
    from datetime import datetime, timezone, timedelta
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone(timedelta(hours=-3))).date().isoformat()
    except Exception:
        return iso[:10]


def _itens_json(itens) -> list:
    """Serializa DemandaItem[] para gravar no jsonb."""
    out = []
    for it in itens or []:
        out.append({
            "produto_id": str(it.produto_id) if it.produto_id else None,
            "codigo": it.codigo,
            "descricao": it.descricao,
            "qtd": float(it.qtd or 0),
            "valor": float(it.valor or 0),
        })
    return out


def _notas_json(notas) -> list:
    """Serializa NotaComunicado[] para o jsonb."""
    out = []
    for n in notas or []:
        out.append({
            "numero_nf": (n.numero_nf or "").strip(),
            "numero_pedido": (n.numero_pedido or "").strip() or None,
            "itens": _itens_json(n.itens),
        })
    return out


def _valor_da_nota(nota: dict) -> float:
    """Σ qtd × valor unitário dos itens da nota.

    O valor da NF sai dos itens, nunca de um total digitado: com várias notas na
    mesma AF, um total à mão não tem como ser conferido depois — não se sabe qual
    item entrou em qual nota."""
    return round(sum(float(i.get("qtd") or 0) * float(i.get("valor") or 0)
                     for i in (nota.get("itens") or [])), 2)


def _notas_normalizadas(payload, itens_fallback=None) -> list:
    """A lista de notas do comunicado, em jsonb.

    Aceita as duas formas de chamada: `notas=[...]` (nova) e
    `numero_nf` + `itens` soltos (como a API era antes, e como o CRM e scripts
    antigos ainda chamam). A forma antiga vira uma nota só."""
    if getattr(payload, "notas", None):
        return _notas_json(payload.notas)
    nf = (getattr(payload, "numero_nf", None) or "").strip()
    if not nf:
        return []
    itens = itens_fallback if itens_fallback is not None else (getattr(payload, "itens", None) or [])
    return [{
        "numero_nf": nf,
        "numero_pedido": (getattr(payload, "numero_pedido", None) or "").strip() or None,
        "itens": _itens_json(itens),
    }]


def _validar_notas_comunicado(notas: list) -> None:
    """Cada nota precisa de número e de itens com quantidade e valor.

    Sem itens com valor a nota não tem valor, e um comunicado sem valor não entra
    no faturamento — ficaria parecendo lançado e invisível no resultado."""
    if not notas:
        raise HTTPException(
            status_code=422,
            detail="Informe pelo menos uma nota fiscal deste comunicado.",
        )
    vistos = set()
    for n in notas:
        nf = (n.get("numero_nf") or "").strip()
        if not nf:
            raise HTTPException(status_code=422, detail="Há uma nota sem número — preencha ou remova.")
        if nf in vistos:
            raise HTTPException(
                status_code=422,
                detail=f"A NF '{nf}' está repetida neste comunicado.",
            )
        vistos.add(nf)
        uteis = [i for i in (n.get("itens") or [])
                 if i.get("produto_id") and float(i.get("qtd") or 0) > 0]
        if not uteis:
            raise HTTPException(
                status_code=422,
                detail=f"Informe os itens e quantidades da NF {nf} — é o que foi usado no paciente.",
            )
        if any(float(i.get("valor") or 0) <= 0 for i in uteis):
            raise HTTPException(
                status_code=422,
                detail=f"Informe o valor unitário de cada item da NF {nf} — é o que dá o valor da nota.",
            )


def _itens_das_notas(notas: list) -> list:
    """Todos os itens das notas somados por produto.

    A coluna `itens` da demanda continua existindo e é lida pelo painel, pelo
    relatório e pela comparação previsto × realizado. Ela passa a ser a soma das
    notas — não uma terceira verdade mantida à mão."""
    soma: dict = {}
    for n in notas or []:
        for i in (n.get("itens") or []):
            pid = i.get("produto_id")
            if not pid:
                continue
            alvo = soma.setdefault(pid, {
                "produto_id": pid, "codigo": i.get("codigo"),
                "descricao": i.get("descricao"), "qtd": 0.0, "valor": 0.0,
                "_total": 0.0,
            })
            qtd = float(i.get("qtd") or 0)
            alvo["qtd"] += qtd
            alvo["_total"] += qtd * float(i.get("valor") or 0)

    # O mesmo item pode sair em duas notas com preço diferente. O unitário do
    # espelho é a média ponderada, e não o primeiro que apareceu: assim
    # qtd × valor continua dando o total de verdade, que é o número que alguém
    # vai conferir contra as notas.
    saida = []
    for alvo in soma.values():
        total, qtd = alvo.pop("_total"), alvo["qtd"]
        alvo["valor"] = round(total / qtd, 4) if qtd else 0.0
        saida.append(alvo)
    return saida


def _serializar(d: dict) -> dict:
    return {
        "id": d["id"],
        "tipo_operacao": d.get("tipo_operacao"),
        "etapa": _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa")),
        "ref_externa": d.get("ref_externa"),
        "numero_pregao": d.get("numero_pregao"),
        "numero": d.get("numero"),
        "cliente_id": d.get("cliente_id"),
        "cliente": (d.get("clientes") or {}).get("nome") if d.get("clientes") else None,
        "canal": d.get("canal"),
        "prazo": d.get("prazo"),
        "prioridade": d.get("prioridade") or "NORMAL",
        "observacao": d.get("observacao"),
        "responsavel_id": d.get("responsavel_id"),
        "nome_paciente": d.get("nome_paciente"),
        "prontuario": d.get("prontuario"),
        "numero_nf": d.get("numero_nf"),
        "data_procedimento": d.get("data_procedimento"),
        "itens": d.get("itens") or [],
        # Cada nota ja sai com o valor calculado — a tela nao precisa repetir a
        # conta, e a conta e uma so em todo lugar.
        "notas": [dict(n, valor=_valor_da_nota(n)) for n in (d.get("notas") or [])],
        "gerado_tipo": d.get("gerado_tipo"),
        "gerado_id": d.get("gerado_id"),
        "gerado_ref": d.get("gerado_ref"),
        "frete": d.get("frete"),
        "nf": d.get("nf"),
        "estoque": d.get("estoque"),
        "ovs": d.get("ovs") or [],
        "ovs_detalhe": None,
        "ov_status": None,
        "ov_itens": None,
        "criado_em": d.get("criado_em"),
        "atualizado_em": d.get("atualizado_em"),
        "concluido_em": d.get("concluido_em"),
    }


def _ov_ids_de(d: dict) -> list:
    """Ids de todas as OVs vinculadas à demanda (lista `ovs`, com fallback para o
    gerado_id legado quando ainda não foi migrado)."""
    ids = [o.get("id") for o in (d.get("ovs") or []) if o.get("id")]
    if not ids and d.get("gerado_tipo") in ("PEDIDO", "COMUNICADO") and d.get("gerado_id"):
        ids = [d.get("gerado_id")]
    return ids


def _anexar_ov_status(db, demandas: list) -> None:
    """Para demandas vinculadas a OVs, busca o status atual e os itens reais de
    cada OV para o card espelhar o fluxo logístico ao vivo e comparar as
    quantidades da triagem (previsto) com o total faturado nas OVs (realizado)."""
    todos: list = []
    for d in demandas:
        todos.extend(_ov_ids_de(d))
    if not todos:
        return
    uniq = list(dict.fromkeys(todos))
    status_map: dict = {}
    itens_map: dict = {}
    for i in range(0, len(uniq), 80):
        lote = uniq[i:i + 80]
        for p in db.table("pedidos").select("id, numero_pedido, status, numero_nf").in_("id", lote).execute().data:
            status_map[p["id"]] = {"numero": p.get("numero_pedido"), "status": p.get("status"), "nf": p.get("numero_nf")}
        itrows = db.table("itens_pedido")\
            .select("pedido_id, produto_id, qtd_solicitada, produtos(codigo, descricao)")\
            .in_("pedido_id", lote).execute().data
        for it in itrows:
            prod = it.get("produtos") or {}
            itens_map.setdefault(it["pedido_id"], []).append({
                "produto_id": it.get("produto_id"),
                "codigo": prod.get("codigo"),
                "descricao": prod.get("descricao"),
                "qtd": float(it.get("qtd_solicitada") or 0),
            })
    for d in demandas:
        ids = _ov_ids_de(d)
        if not ids:
            continue
        d["ovs_detalhe"] = [{
            "id": i,
            "numero": (status_map.get(i) or {}).get("numero"),
            "status": (status_map.get(i) or {}).get("status"),
            "nf": (status_map.get(i) or {}).get("nf"),
        } for i in ids]
        prim = status_map.get(ids[0])
        if prim:
            d["ov_status"] = prim.get("status")
        # Soma dos itens de todas as OVs (por produto) = total realizado.
        agg: dict = {}
        for i in ids:
            for it in itens_map.get(i, []):
                k = it.get("produto_id") or it.get("codigo")
                cur = agg.setdefault(k, {"produto_id": it.get("produto_id"), "codigo": it.get("codigo"),
                                         "descricao": it.get("descricao"), "qtd": 0.0})
                cur["qtd"] += it.get("qtd") or 0.0
        if agg:
            d["ov_itens"] = list(agg.values())


def _anexar_estoque_pcp(demandas: list) -> None:
    """Para demandas AGUARDANDO_ESTOQUE, cruza os itens com o PCP (view
    `pa_coverage`) e sinaliza quando o material já está disponível AGORA.

    Motivo: o card hoje só mostra a previsão que o operador digitou à mão ao
    marcar "sem estoque" — se o PCP repôs antes da data prevista, ninguém
    percebe até checar manualmente, e a venda direta fica parada por engano
    mesmo com estoque de sobra. `pcp_estoque_service.cobertura_da_demanda` já
    existia pronta para isso, só não estava plugada em lugar nenhum."""
    from app.services import pcp_estoque_service
    for d in demandas:
        if d.get("etapa") != "AGUARDANDO_ESTOQUE":
            continue
        try:
            cob = pcp_estoque_service.cobertura_da_demanda(d)
        except Exception:
            # Integração do PCP fora do ar: card segue com a previsão manual,
            # sem o selo — não pode derrubar o painel de licitações.
            cob = {"itens": [], "pior_status": None, "integracao": False}
        itens = cob.get("itens") or []
        d["estoque_pcp"] = {
            "integracao": cob.get("integracao", False),
            "itens": itens,
            # Só fecha "disponível agora" se TODOS os itens da demanda atendem —
            # material parcial não libera a venda direta.
            "disponivel_agora": bool(itens) and len(itens) == len(d.get("itens") or []) and all(it.get("atende") for it in itens),
        }


def listar_demandas() -> list:
    """Painel do dia: pendentes (qualquer dia) + concluídas HOJE. As concluídas de
    dias anteriores saem do painel automaticamente (ficam no histórico)."""
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("criado_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    hoje = _hoje_brt()

    def visivel(d: dict) -> bool:
        if d["etapa"] not in ETAPAS_FINAIS:
            return True
        ce = d.get("concluido_em")
        return (not ce) or _data_brt(ce) == hoje

    demandas = [d for d in demandas if visivel(d)]
    _anexar_ov_status(db, demandas)
    _anexar_estoque_pcp(demandas)
    demandas.sort(key=lambda d: (_PRIORIDADE_PESO.get(d["prioridade"], 3), d.get("prazo") or "9999"))
    return demandas


def historico_datas() -> list:
    """Dias que têm demandas concluídas, com a contagem — para o seletor do histórico."""
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("etapa, concluido_em")\
        .eq("ativo", True).execute().data
    cont: dict = {}
    for r in rows:
        etapa = _ETAPA_LEGADA.get(r.get("etapa"), r.get("etapa"))
        ce = r.get("concluido_em")
        if etapa in ETAPAS_FINAIS and ce:
            dia = _data_brt(ce)
            cont[dia] = cont.get(dia, 0) + 1
    return sorted([{"data": k, "total": v} for k, v in cont.items()], key=lambda x: x["data"], reverse=True)


def historico_demandas(data: str) -> list:
    """Demandas concluídas em uma data específica (fuso de Brasília)."""
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("concluido_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    alvo = (data or "").strip()[:10]
    out = [d for d in demandas
           if d["etapa"] in ETAPAS_FINAIS and d.get("concluido_em") and _data_brt(d["concluido_em"]) == alvo]
    _anexar_ov_status(db, out)
    return out


def historico_buscar(termo: str) -> list:
    """Busca em TODAS as demandas ativas — concluídas ou ainda em andamento —
    por pregão, NE, AF, paciente, prontuário, cliente ou OV. Não se limita ao
    que já foi concluído: se alguém já está processando o mesmo caso, o
    operador precisa ver isso ANTES de criar de novo, senão a busca não evita
    a duplicidade que deveria evitar."""
    q = (termo or "").strip().lower()
    if not q:
        return []
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("criado_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    _anexar_ov_status(db, demandas)

    def casa(d: dict) -> bool:
        campos = [d.get("numero_pregao"), d.get("numero"), d.get("cliente"),
                  d.get("ref_externa"), d.get("gerado_ref"),
                  d.get("nome_paciente"), d.get("prontuario"), d.get("numero_nf")]
        for ov in (d.get("ovs_detalhe") or []):
            campos.append(ov.get("numero"))
        return any(q in str(c).lower() for c in campos if c)

    out = [d for d in demandas if casa(d)]
    out.sort(key=lambda d: d.get("concluido_em") or d.get("atualizado_em") or d.get("criado_em") or "", reverse=True)
    return out[:100]


def relatorio(tipo: Optional[str] = None, canal: Optional[str] = None,
              data_inicio: Optional[str] = None, data_fim: Optional[str] = None) -> list:
    """Relatório completo — tudo que já foi feito de venda direta, comunicado de
    uso e consignação, filtrável por tipo/canal/período. Substitui o controle em
    planilha: cada linha traz pregão/AF, paciente/prontuário (comunicado), NF(s)
    e valor total, com a data de referência sendo a de conclusão (ou criação,
    se ainda em andamento)."""
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("criado_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    _anexar_ov_status(db, demandas)

    for d in demandas:
        d["data_ref"] = (d.get("concluido_em") or d.get("criado_em") or "")[:10]
        d["valor_total"] = sum(float(it.get("qtd") or 0) * float(it.get("valor") or 0) for it in (d.get("itens") or []))

    def dentro(d: dict) -> bool:
        if tipo and d["tipo_operacao"] != tipo:
            return False
        if canal and d.get("canal") != canal:
            return False
        if data_inicio and d["data_ref"] < data_inicio:
            return False
        if data_fim and d["data_ref"] > data_fim:
            return False
        return True

    out = [d for d in demandas if dentro(d)]
    out.sort(key=lambda d: d["data_ref"], reverse=True)
    return out


def _pregao_id_por_numero(db, numero_pregao: str) -> str | None:
    """Se já existe um PREGÃO MESTRE com esse número, devolve o pregao_id — a NE
    entra como uma linha desse contrato (consumindo o saldo), não como um
    contrato novo e desconectado. Sem isso, a NE só se juntaria ao pregão bem
    depois, no backfill da aba Contratos.

    Não recusa por saldo: o total de pregões vindos do backfill legado é
    presumido (= o que já estava empenhado), então o saldo aparece zerado e
    barrar aqui trancaria o lançamento de NEs novas. Se o empenhado passar do
    total, o pregão sinaliza isso na tela para o total ser corrigido.

    Devolve None se o pregão ainda não existe (o contrato nasce solto, como
    antes — vira o próprio pregão quando alguém abrir a aba Contratos)."""
    numero_pregao = (numero_pregao or "").strip()
    if not numero_pregao:
        return None
    rows = db.table("pregoes").select("id").eq("numero", numero_pregao).eq("ativo", True).execute().data
    return rows[0]["id"] if rows else None


def _garantir_contrato_vd(db, d: dict) -> str | None:
    """Garante que exista o contrato (empenho) de uma venda direta, criando-o com
    as quantidades da triagem se ainda não houver. Idempotente: se já existe um
    empenho com o mesmo número, reusa. Devolve o empenho_id (ou None)."""
    if d.get("tipo_operacao") != "VENDA_DIRETA":
        return None
    contrato_num = (d.get("numero") or "").strip() or (d.get("numero_pregao") or "").strip()
    if not contrato_num:
        return None
    existente = db.table("empenhos").select("id").eq("numero", contrato_num).eq("ativo", True).execute().data
    if existente:
        return existente[0]["id"]
    itens_emp = [EmpenhoItemCreate(produto_id=it.get("produto_id"),
                                   qtd_empenhada=float(it.get("qtd") or 0),
                                   valor_unitario=float(it.get("valor") or 0))
                 for it in (d.get("itens") or [])
                 if it.get("produto_id") and float(it.get("qtd") or 0) > 0]
    if not itens_emp:
        return None

    from app.services import licitacao_service
    numero_pregao = (d.get("numero_pregao") or "").strip()
    pregao_id = _pregao_id_por_numero(db, numero_pregao)
    emp = licitacao_service.criar_empenho(EmpenhoCreate(
        numero=contrato_num,
        numero_pregao=numero_pregao or None,
        cliente_id=d["cliente_id"], tipo="VENDA_DIRETA",
        canal=d.get("canal"), vigencia=None, itens=itens_emp,
        pregao_id=pregao_id,
    ))
    return emp.get("id")


def criar_demanda(payload: DemandaCreate) -> dict:
    if payload.tipo_operacao not in TIPOS:
        raise HTTPException(status_code=422, detail="Tipo de operação inválido")
    db = get_service_db()
    num = (payload.numero or "").strip()
    notas: list = []
    # Comunicado de uso é regido pela AF + paciente + prontuário — obrigatórios
    # para rastreabilidade (evita o time processar o mesmo caso duas vezes).
    if payload.tipo_operacao == "COMUNICADO_USO":
        if not num:
            raise HTTPException(status_code=422, detail="Informe a AF (Autorização de Fornecimento).")
        if not (payload.nome_paciente or "").strip():
            raise HTTPException(status_code=422, detail="Informe o nome do paciente.")
        if not (payload.prontuario or "").strip():
            raise HTTPException(status_code=422, detail="Informe o prontuário.")
        if not payload.data_procedimento:
            raise HTTPException(status_code=422, detail="Informe a data do procedimento.")
        if not (payload.canal or "").strip():
            raise HTTPException(status_code=422, detail="Informe o canal.")
        # Uma AF, varias notas. O e-mail da licitacao chega assim: "NF 20476 e
        # NF 20480, referente ao comunicado de uso 57048".
        notas = _notas_normalizadas(payload)
        _validar_notas_comunicado(notas)
    elif payload.tipo_operacao in ("VENDA_DIRETA", "CONSIGNACAO"):
        if not num:
            raise HTTPException(status_code=422, detail="Informe a Nota de Empenho (NE).")
        # Sem itens a NE não vira linha do contrato (não há o que empenhar) — a
        # demanda ficava no painel e o contrato nunca recebia a linha, calado.
        if payload.tipo_operacao == "VENDA_DIRETA" and not [
            it for it in (payload.itens or []) if it.produto_id and float(it.qtd or 0) > 0
        ]:
            raise HTTPException(
                status_code=422,
                detail="Informe os itens e quantidades da NE — é o que vira a linha do contrato do pregão.",
            )
    # Anti-duplicidade: o mesmo número (empenho/AF/pregão) não pode ter duas
    # demandas EM ANDAMENTO — evita o time processar o mesmo pedido duas vezes.
    #
    # Demanda já concluída não bloqueia mais, no comunicado de uso, e isso é uma
    # correção: a regra olhava só `ativo`, que continua true depois de concluir,
    # então cada AF lançada travava a si mesma para sempre. Uma AF volta com nota
    # nova o tempo todo — o cliente usa mais material do mesmo consignado, e o
    # faturamento sai em notas separadas.
    #
    # O que protege de faturar duas vezes não é a AF, é a NF: documento fiscal
    # não se emite duas vezes. A checagem de NF vem logo abaixo.
    if num:
        candidatas = (
            db.table("licitacao_demandas")
            .select("id, etapa, clientes(nome)")
            .eq("ativo", True).eq("numero", num).execute().data
        )
        dup = [d for d in candidatas
               if payload.tipo_operacao != "COMUNICADO_USO"
               or _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa")) not in ETAPAS_FINAIS]
        if dup:
            cli = (dup[0].get("clientes") or {}).get("nome") or "cliente não informado"
            campo = "AF" if payload.tipo_operacao == "COMUNICADO_USO" else "número"
            raise HTTPException(
                status_code=409,
                detail=f"Já existe uma demanda em andamento com o {campo} '{num}' ({cli}). "
                       f"Confira no painel/histórico antes de criar — risco de processar duas vezes.",
            )

    # A NF é a trava de verdade: a mesma nota não sai duas vezes. Barrar aqui, e
    # não só na conclusão, poupa o operador de preencher o card inteiro para
    # descobrir no fim que a nota já tinha sido lançada.
    if payload.tipo_operacao == "COMUNICADO_USO" and notas:
        ja = (
            db.table("pedidos").select("numero_pedido, numero_nf")
            .in_("numero_nf", [n["numero_nf"] for n in notas])
            .neq("status", "CANCELADO").execute().data
        )
        if ja:
            q = ja[0]
            raise HTTPException(
                status_code=409,
                detail=f"A NF {q['numero_nf']} já está lançada na {q['numero_pedido']}. "
                       f"Se esta é outra nota da mesma AF, confira o número.",
            )
    row = db.table("licitacao_demandas").insert({
        "tipo_operacao": payload.tipo_operacao,
        "etapa": "RECEBIDO",
        "numero_pregao": (payload.numero_pregao or "").strip() or None,
        "numero": num or None,
        "cliente_id": str(payload.cliente_id),
        "canal": payload.canal,
        "prazo": payload.prazo.isoformat() if payload.prazo else None,
        "prioridade": payload.prioridade or "NORMAL",
        "observacao": payload.observacao,
        "itens": _itens_das_notas(notas) if notas else _itens_json(payload.itens),
        "notas": notas,
        "nome_paciente": (payload.nome_paciente or "").strip() or None,
        "prontuario": (payload.prontuario or "").strip() or None,
        # Espelham a PRIMEIRA nota: o painel, o relatorio e a busca leem daqui.
        "numero_nf": (notas[0]["numero_nf"] if notas else None),
        "data_procedimento": payload.data_procedimento.isoformat() if payload.data_procedimento else None,
        "ativo": True,
    }).execute().data[0]
    # Venda direta "ganhou o pregão" → já cria o contrato com as quantidades
    # da triagem (o card segue no kanban; o contrato aparece na aba Contratos).
    # Erro de validação (ex.: item/quantidade não cabe no saldo do pregão já
    # existente) precisa aparecer pro operador — só engole falha inesperada.
    try:
        _garantir_contrato_vd(db, obter_demanda(row["id"]))
    except HTTPException:
        raise
    except Exception:
        pass
    return obter_demanda(row["id"])


def obter_demanda(demanda_id: str) -> dict:
    db = get_service_db()
    r = db.table("licitacao_demandas").select("*, clientes(nome)").eq("id", demanda_id).single().execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    d = _serializar(r)
    _anexar_ov_status(db, [d])
    return d


def vincular_ov(demanda_id: str, numero_pedido: str) -> dict:
    """Vincula a demanda a uma OV existente no fluxo logístico. O card passa a
    espelhar o status real da OV (aguardando faturamento, faturado, expedido…)."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    num = (numero_pedido or "").strip().upper()
    if not num:
        raise HTTPException(status_code=422, detail="Informe o número da OV")
    peds = db.table("pedidos").select("id, numero_pedido, status, criado_em")\
        .eq("numero_pedido", num).neq("status", "CANCELADO").order("criado_em", desc=True).execute().data
    if not peds:
        raise HTTPException(status_code=404, detail=f"Nenhuma OV ativa encontrada com o número '{num}'.")
    ped = peds[0]
    ovs = list(d.get("ovs") or [])
    if not any(o.get("id") == ped["id"] for o in ovs):
        ovs.append({"id": ped["id"], "numero": ped["numero_pedido"]})
    update = {"ovs": ovs, "atualizado_em": _agora()}
    if not d.get("gerado_id"):
        update.update({
            "gerado_tipo": "PEDIDO",
            "gerado_id": ped["id"],
            "gerado_ref": ped["numero_pedido"],
            "ref_externa": ped["numero_pedido"],
        })
    if _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa")) == "RECEBIDO":
        update["etapa"] = "PROCESSANDO"
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def _saldo_demanda(db, d: dict) -> dict:
    """Saldo por produto = total da triagem − soma do que já saiu nas OVs vinculadas."""
    total: dict = {}
    for it in (d.get("itens") or []):
        pid = it.get("produto_id")
        if pid:
            total[pid] = total.get(pid, 0.0) + float(it.get("qtd") or 0)
    ids = _ov_ids_de(d)
    entregue: dict = {}
    for i in range(0, len(ids), 80):
        lote = ids[i:i + 80]
        for it in db.table("itens_pedido").select("produto_id, qtd_solicitada").in_("pedido_id", lote).execute().data:
            pid = it.get("produto_id")
            if pid:
                entregue[pid] = entregue.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)
    return {pid: max(0.0, q - entregue.get(pid, 0.0)) for pid, q in total.items()}


def _itens_do_pregao(db, numero_pregao: str) -> dict:
    """produto_id -> item do pregão (com qtd_saldo e preço), para demandas que
    ficaram sem itens na triagem: sem isso o saldo delas é zero e a OV fica
    impossível de gerar, mesmo o pregão tendo saldo de sobra."""
    pregao_id = _pregao_id_por_numero(db, numero_pregao or "")
    if not pregao_id:
        return {}
    from app.services import pregao_service
    try:
        det = pregao_service.obter_pregao(pregao_id)
    except Exception:
        return {}
    return {i["produto_id"]: i for i in (det.get("itens") or [])}


# tipo_operacao da OV no fluxo logístico conforme o tipo da demanda
_TIPO_OP_OV = {"VENDA_DIRETA": "VENDA_NORMAL", "CONSIGNACAO": "CONSIGNADO"}


def gerar_ov_saldo(demanda_id: str, payload, usuario: UsuarioOut) -> dict:
    """Gera uma OV no fluxo logístico com o saldo (ou parte dele) de uma venda
    direta / consignação. A OV é vinculada à demanda; o saldo restante continua
    rastreado. Se payload.concluir, a demanda também é marcada como concluída
    (fluxo padrão: processa no D365, depois gera a OV ao concluir)."""
    from app.services import pedido_service

    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    tipo_demanda = d.get("tipo_operacao")
    if tipo_demanda not in _TIPO_OP_OV:
        raise HTTPException(status_code=400, detail="Gerar OV vale só para venda direta e consignação.")
    if not payload.itens:
        raise HTTPException(status_code=422, detail="Informe ao menos um item para a OV.")

    saldo = _saldo_demanda(db, d)
    # Preço unitário digitado na triagem segue junto para a OV (sugere o valor da
    # NF no faturamento sem redigitar).
    preco_triagem = {it.get("produto_id"): float(it.get("valor") or 0)
                     for it in (d.get("itens") or []) if it.get("produto_id")}
    # Demanda sem itens na triagem (criada antes de virarem obrigatórios): o teto
    # passa a ser o saldo do PREGÃO, e o que for escolhido aqui é gravado como os
    # itens da demanda — senão ela fica presa em "sem saldo a faturar".
    itens_pregao = {} if (d.get("itens") or []) else _itens_do_pregao(db, d.get("numero_pregao"))
    if itens_pregao:
        saldo = {pid: float(i.get("qtd_saldo") or 0) for pid, i in itens_pregao.items()}
        preco_triagem = {pid: float(i.get("valor_unitario") or 0) for pid, i in itens_pregao.items()}
    for it in payload.itens:
        pid = str(it.produto_id)
        if it.qtd_solicitada > saldo.get(pid, 0.0) + 0.001:
            raise HTTPException(status_code=422, detail=f"Quantidade acima do saldo do item (saldo {round(saldo.get(pid, 0.0))}).")
        if it.valor_unitario is None and preco_triagem.get(pid):
            it.valor_unitario = preco_triagem[pid]

    if itens_pregao:
        novos_itens = []
        for it in payload.itens:
            base = itens_pregao.get(str(it.produto_id), {})
            novos_itens.append({
                "produto_id": str(it.produto_id),
                "codigo": base.get("codigo"),
                "descricao": base.get("descricao"),
                "qtd": float(it.qtd_solicitada),
                "valor": float(it.valor_unitario or base.get("valor_unitario") or 0),
            })
        # Grava antes de _garantir_contrato_vd para a linha (NE) do contrato nascer
        # com essas quantidades.
        d["itens"] = novos_itens
        db.table("licitacao_demandas").update({"itens": novos_itens, "atualizado_em": _agora()})\
            .eq("id", demanda_id).execute()

    # Frete cotado na demanda vai para a OV (transportadora + tipo). O valor cotado
    # entra nas observações (o valor de frete formal é confirmado no faturamento).
    frete = d.get("frete") or {}
    transp_id = getattr(payload, "transportadora_id", None) or frete.get("transportadora_id")
    valor_frete = getattr(payload, "valor_frete", None)
    if valor_frete is None:
        valor_frete = frete.get("valor")
    obs = None
    if valor_frete or frete.get("transportadora_nome"):
        partes = []
        if frete.get("transportadora_nome"):
            partes.append(f"Transportadora: {frete.get('transportadora_nome')}")
        if valor_frete:
            partes.append(f"Frete cotado: R$ {float(valor_frete):.2f}")
        if frete.get("prazo_dias"):
            partes.append(f"Prazo: {frete.get('prazo_dias')} dia(s)")
        obs = " · ".join(partes)

    # Contrato automático: se ainda não existe um contrato (empenho) para esta
    # venda direta, cria um por baixo dos panos com as quantidades totais da
    # triagem — assim o saldo é rastreado sem o operador dar um passo extra.
    empenho_id = _garantir_contrato_vd(db, d) if tipo_demanda == "VENDA_DIRETA" else None

    ped = pedido_service.criar_pedido(
        PedidoCreate(
            numero_pedido=payload.numero_pedido,
            cliente_id=d["cliente_id"],
            transportadora_id=transp_id,
            tipo_frete=payload.tipo_frete or "CIF_SEM_VALOR",
            tipo_operacao=_TIPO_OP_OV[tipo_demanda],
            canal=payload.canal or d.get("canal"),
            local_entrega=payload.local_entrega,
            data_prevista_entrega=payload.data_prevista_entrega,
            condicao_pagamento=payload.condicao_pagamento,
            observacoes=obs,
            valor_frete=float(valor_frete) if valor_frete else None,
            empenho_id=empenho_id,
            itens=payload.itens,
        ),
        usuario,
    )
    ovs = list(d.get("ovs") or [])
    if not any(o.get("id") == ped["id"] for o in ovs):
        ovs.append({"id": ped["id"], "numero": ped["numero_pedido"]})
    update = {"ovs": ovs, "etapa": "OV_GERADA", "atualizado_em": _agora()}
    if not d.get("gerado_id"):
        update.update({
            "gerado_tipo": "PEDIDO",
            "gerado_id": ped["id"],
            "gerado_ref": ped["numero_pedido"],
            "ref_externa": ped["numero_pedido"],
        })
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    res = obter_demanda(demanda_id)
    res["ov_gerada_id"] = ped.get("id")
    res["ov_gerada_ref"] = ped.get("numero_pedido")
    return res


def registrar_frete(demanda_id: str, payload) -> dict:
    """Cotação de frete (CIF sem valor). Guarda transportadora + valor + prazo na
    demanda; esses dados vão para a OV ao gerá-la. Avança a etapa para Cotação de frete."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    frete = {
        "transportadora_id": str(payload.transportadora_id) if payload.transportadora_id else None,
        "transportadora_nome": (payload.transportadora_nome or "").strip() or None,
        "valor": float(payload.valor) if payload.valor is not None else None,
        "prazo_dias": int(payload.prazo_dias) if payload.prazo_dias is not None else None,
        "tipo_frete": payload.tipo_frete or "CIF_SEM_VALOR",
        "observacao": (payload.observacao or "").strip() or None,
    }
    update = {"frete": frete, "atualizado_em": _agora()}
    if _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa")) in ("RECEBIDO", "PROCESSANDO", "OV_GERADA"):
        update["etapa"] = "COTACAO_FRETE"
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def enviar_nf(demanda_id: str, payload, usuario: UsuarioOut) -> dict:
    """Registra o envio da NF ao cliente — fechamento da demanda (etapa NF enviada)."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    nf = {
        "numero": (payload.numero or "").strip() or None,
        "enviada_em": payload.enviada_em.isoformat() if payload.enviada_em else _data_brt(_agora()),
        "enviada_por": getattr(usuario, "nome", None) or getattr(usuario, "email", None),
        "observacao": (payload.observacao or "").strip() or None,
    }
    db.table("licitacao_demandas").update({
        "nf": nf,
        "etapa": "NF_ENVIADA",
        "concluido_em": _agora(),
        "atualizado_em": _agora(),
    }).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def risco_multa_estoque(demanda: dict, hoje_iso: str) -> bool:
    """Demanda sem estoque que já ameaça multa contratual: a previsão do PCP cai
    depois do prazo, ou o prazo simplesmente já venceu.

    Vive aqui (e não em quem consome) porque é regra de negócio de licitação — o
    resumo do Teams e a tela de início leem a MESMA definição, senão um alerta
    diria uma coisa e o outro diria outra para o mesmo card.
    """
    prazo = demanda.get("prazo")
    if not prazo:
        return False
    previsao = (demanda.get("estoque") or {}).get("previsao_pcp")
    return bool((previsao and previsao > prazo) or prazo < hoje_iso)


def marcar_sem_estoque(demanda_id: str, payload) -> dict:
    """Sinaliza que o pedido não tem estoque disponível. O card vai para a coluna
    'Aguardando estoque (PCP)' e NÃO sai do painel — fica visível até o estoque
    chegar, para o time nunca esquecer (risco de multa contratual). Guarda a
    previsão informada pelo PCP e (opcionalmente) o prazo de entrega do contrato,
    que é cruzado com a previsão para alertar risco de multa."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    etapa_atual = _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa"))
    anterior = (d.get("estoque") or {}).get("etapa_anterior")
    estoque = {
        "em_falta": True,
        "previsao_pcp": payload.previsao_pcp.isoformat() if payload.previsao_pcp else None,
        "itens_faltantes": [s for s in (payload.itens_faltantes or []) if (s or "").strip()],
        "observacao": (payload.observacao or "").strip() or None,
        # Guarda de onde veio para conseguir voltar quando o estoque chegar.
        "etapa_anterior": etapa_atual if etapa_atual != "AGUARDANDO_ESTOQUE" else (anterior or "PROCESSANDO"),
        "registrado_em": _agora(),
    }
    update = {"estoque": estoque, "etapa": "AGUARDANDO_ESTOQUE", "atualizado_em": _agora()}
    # Permite registrar/atualizar o prazo contratual no mesmo passo (hoje muitos
    # não têm o prazo preenchido, e ele é a base do alerta de multa).
    if getattr(payload, "prazo", None) is not None:
        update["prazo"] = payload.prazo.isoformat()
    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def liberar_estoque(demanda_id: str, payload=None) -> dict:
    """Estoque chegou (ou PCP produziu). Devolve o card ao fluxo normal — volta
    para a etapa em que estava antes de faltar estoque (padrão: em processamento).
    Mantém o histórico do que faltou."""
    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    est = dict(d.get("estoque") or {})
    destino = est.get("etapa_anterior") or "PROCESSANDO"
    if destino not in ETAPAS or destino in ETAPAS_FINAIS or destino == "AGUARDANDO_ESTOQUE":
        destino = "PROCESSANDO"
    est["em_falta"] = False
    est["liberado_em"] = _agora()
    if payload is not None and getattr(payload, "observacao", None):
        est["observacao_liberacao"] = (payload.observacao or "").strip() or None
    db.table("licitacao_demandas").update({
        "estoque": est,
        "etapa": destino,
        "atualizado_em": _agora(),
    }).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def atualizar_demanda(demanda_id: str, payload: DemandaUpdate) -> dict:
    db = get_service_db()
    atual = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")

    update: dict = {"atualizado_em": _agora()}
    if payload.tipo_operacao is not None:
        if payload.tipo_operacao not in TIPOS:
            raise HTTPException(status_code=422, detail="Tipo de operação inválido")
        update["tipo_operacao"] = payload.tipo_operacao
    if payload.etapa is not None:
        etapa = _ETAPA_LEGADA.get(payload.etapa, payload.etapa)
        if etapa not in ETAPAS:
            raise HTTPException(status_code=422, detail="Etapa inválida")
        update["etapa"] = etapa
        # Etapas finais registram a data de conclusão (para o histórico do dia).
        update["concluido_em"] = _agora() if etapa in ETAPAS_FINAIS else None
    if payload.ref_externa is not None:
        update["ref_externa"] = payload.ref_externa.strip() or None
    if payload.numero_pregao is not None:
        update["numero_pregao"] = payload.numero_pregao.strip() or None
    if payload.numero is not None:
        update["numero"] = payload.numero.strip() or None
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.canal is not None:
        update["canal"] = payload.canal or None
    if payload.prazo is not None:
        update["prazo"] = payload.prazo.isoformat()
    if payload.prioridade is not None:
        update["prioridade"] = payload.prioridade
    if payload.observacao is not None:
        update["observacao"] = payload.observacao
    if payload.responsavel_id is not None:
        update["responsavel_id"] = str(payload.responsavel_id)
    if payload.itens is not None:
        update["itens"] = _itens_json(payload.itens)
    if payload.notas is not None:
        notas = _notas_json(payload.notas)
        _validar_notas_comunicado(notas)
        update["notas"] = notas
        # As colunas antigas seguem espelhando a primeira nota e a soma dos itens.
        update["numero_nf"] = notas[0]["numero_nf"]
        update["itens"] = _itens_das_notas(notas)

    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()

    # Itens preenchidos depois (demanda criada sem eles, antes de virarem
    # obrigatórios): agora dá para criar a linha (NE) no contrato do pregão, que
    # na criação foi pulada por falta de item. Best-effort — não trava a edição.
    if payload.itens is not None:
        try:
            _garantir_contrato_vd(db, obter_demanda(demanda_id))
        except Exception:
            pass
    return obter_demanda(demanda_id)


def excluir_demanda(demanda_id: str) -> dict:
    db = get_service_db()
    db.table("licitacao_demandas").update({"ativo": False, "atualizado_em": _agora()})\
        .eq("id", demanda_id).execute()
    return {"ok": True}


def _itens_pedido(itens, rotulo: str) -> list:
    """Converte os itens (produto_id + qtd) para ItemPedidoCreate, validando."""
    validos = [it for it in itens if it.produto_id and float(it.qtd or 0) > 0]
    if not validos:
        raise HTTPException(
            status_code=422,
            detail=f"Informe ao menos um item (produto e quantidade) para {rotulo}.",
        )
    return [ItemPedidoCreate(produto_id=it.produto_id, qtd_solicitada=float(it.qtd)) for it in validos]


def concluir_demanda(demanda_id: str, payload: DemandaConcluir, usuario: UsuarioOut) -> dict:
    from app.services import licitacao_service, pedido_service

    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    etapa_atual0 = _ETAPA_LEGADA.get(d.get("etapa"), d.get("etapa"))
    if d.get("gerado_id") and etapa_atual0 in ETAPAS_FINAIS:
        raise HTTPException(status_code=400, detail="Esta demanda já foi concluída e gerou um registro.")
    # Reaberta (etapa voltou pra antes de concluído) depois de já ter gerado um
    # registro — corrige o que já existe em vez de criar de novo (senão duplica
    # ou esbarra no "já existe um lançamento com esse número").
    reabrindo = bool(d.get("gerado_id")) and etapa_atual0 not in ETAPAS_FINAIS

    tipo = d.get("tipo_operacao")
    if reabrindo and tipo != "COMUNICADO_USO":
        raise HTTPException(status_code=400, detail="Este contrato já foi criado — para corrigir, edite pela aba Contratos.")
    # Cliente confirmado na conclusão prevalece (obrigatório no comunicado de uso).
    cliente_id = str(payload.cliente_id) if getattr(payload, "cliente_id", None) else d.get("cliente_id")
    if not cliente_id:
        raise HTTPException(status_code=422, detail="Informe o cliente.")
    canal = payload.canal or d.get("canal")

    # Itens: usa os informados na conclusão; se vazios, cai nos itens da triagem.
    itens_src = payload.itens
    if not itens_src and d.get("itens"):
        from app.models.schemas import DemandaItem
        itens_src = [DemandaItem(**it) for it in d["itens"]]

    gerado_tipo = gerado_id = gerado_ref = None
    etapa_final = "CONCLUIDO"
    ovs_final = None

    if tipo in ("VENDA_DIRETA", "CONSIGNACAO"):
        # Ambos criam um CONTRATO (empenho) com as quantidades totais do pregão/ata.
        # Venda direta é baixada por OVs parciais; consignação por comunicado de uso.
        if not payload.numero or not payload.numero.strip():
            raise HTTPException(status_code=422, detail="Informe o número do contrato/empenho.")
        itens_emp = [it for it in itens_src if it.produto_id and float(it.qtd or 0) > 0]
        if not itens_emp:
            raise HTTPException(status_code=422, detail="Informe os itens do contrato (produto, quantidade e valor).")
        itens_empenho = [EmpenhoItemCreate(produto_id=it.produto_id, qtd_empenhada=float(it.qtd),
                                            valor_unitario=float(it.valor or 0)) for it in itens_emp]
        numero_pregao_final = (payload.numero_pregao or "").strip() or d.get("numero_pregao")
        pregao_id = _pregao_id_por_numero(db, numero_pregao_final)
        emp = licitacao_service.criar_empenho(
            EmpenhoCreate(
                numero=payload.numero.strip(),
                numero_pregao=numero_pregao_final,
                cliente_id=cliente_id,
                tipo=tipo,
                canal=canal,
                data_empenho=payload.data_empenho,
                vigencia=payload.vigencia,
                observacao=d.get("observacao"),
                itens=itens_empenho,
                pregao_id=pregao_id,
            )
        )
        gerado_tipo, gerado_id, gerado_ref = "CONTRATO", emp.get("id"), emp.get("numero")

        # Atalho de entrega única (venda direta): já gera a OV cheia baixando todo
        # o saldo. A demanda segue no painel em "OV gerada" para cotar frete/enviar NF.
        if getattr(payload, "gerar_ov", False) and tipo == "VENDA_DIRETA":
            if not payload.numero_pedido or not payload.numero_pedido.strip():
                raise HTTPException(status_code=422, detail="Informe o número da OV para gerar a entrega junto.")
            if not (payload.condicao_pagamento or "").strip():
                raise HTTPException(status_code=422, detail="Informe a condição de pagamento da OV.")
            from app.models.schemas import EntregaVendaDiretaCreate
            itens_ov = [ItemPedidoCreate(
                produto_id=it["produto_id"],
                qtd_solicitada=float(it.get("qtd_empenhada") or it.get("qtd_saldo") or 0),
                valor_unitario=(float(it.get("valor_unitario")) if it.get("valor_unitario") else None),
            ) for it in (emp.get("itens") or []) if it.get("produto_id") and float(it.get("qtd_empenhada") or 0) > 0]
            entrega = licitacao_service.registrar_entrega(
                emp["id"],
                EntregaVendaDiretaCreate(
                    numero_pedido=payload.numero_pedido.strip().upper(),
                    tipo_frete=payload.tipo_frete or "CIF_SEM_VALOR",
                    canal=canal,
                    data_prevista_entrega=payload.data_prevista_entrega or _hoje_brt(),
                    local_entrega=payload.local_entrega,
                    condicao_pagamento=payload.condicao_pagamento,
                    itens=itens_ov,
                ),
                usuario,
            )
            # A OV vira um card próprio no kanban (criado por registrar_entrega),
            # que acompanha frete/NF. O contrato (esta demanda) fica concluído.

    elif tipo == "COMUNICADO_USO":
        # O numero do lancamento e cobrado POR NOTA mais abaixo: com varias notas
        # na mesma AF, cada uma vira um lancamento e tem o seu numero.
        numped = (payload.numero_pedido or "").strip().upper()

        # AF/paciente/prontuário: o que rege o comunicado. Payload (editado na
        # conclusão) prevalece; senão usa o que já foi capturado na triagem.
        af = (payload.numero or "").strip() or d.get("numero")
        nome_paciente = (payload.nome_paciente or "").strip() or d.get("nome_paciente")
        prontuario = (payload.prontuario or "").strip() or d.get("prontuario")
        if not af:
            raise HTTPException(status_code=422, detail="Informe a AF (Autorização de Fornecimento).")
        if not nome_paciente:
            raise HTTPException(status_code=422, detail="Informe o nome do paciente.")
        if not prontuario:
            raise HTTPException(status_code=422, detail="Informe o prontuário.")

        # Se o comunicado com esse número já existe (faturado no D365/app), apenas
        # vincula a demanda a ele e conclui — não lança de novo (evita duplicidade).
        # Não vale quando a demanda foi reaberta pra corrigir algo — nesse caso o
        # "existente" é o próprio lançamento que ela já gerou, e o objetivo é
        # atualizar os dados errados, não só vincular de novo.
        existente = None if (reabrindo or not numped) else db.table("pedidos").select("id, numero_pedido")\
            .eq("numero_pedido", numped).neq("status", "CANCELADO").limit(1).execute().data
        if existente:
            p = existente[0]
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", p["id"], p["numero_pedido"]
            db.table("licitacao_demandas").update({
                "etapa": "CONCLUIDO",
                "gerado_tipo": gerado_tipo,
                "gerado_id": gerado_id,
                "gerado_ref": gerado_ref,
                "cliente_id": cliente_id,
                "canal": canal,
                "numero": af,
                "nome_paciente": nome_paciente,
                "prontuario": prontuario,
                "concluido_em": _agora(),
                "atualizado_em": _agora(),
            }).eq("id", demanda_id).execute()
            return obter_demanda(demanda_id)

        data_procedimento = payload.data_procedimento or (
            date.fromisoformat(d["data_procedimento"]) if d.get("data_procedimento") else None
        )

        # As notas desta conclusao: o que veio no payload; senao o que a triagem
        # ja capturou no card.
        notas_concluir = _notas_normalizadas(payload, itens_fallback=itens_src)             or [dict(n) for n in (d.get("notas") or [])]
        for n in notas_concluir:
            n["valor"] = _valor_da_nota(n)
        _validar_notas_comunicado(notas_concluir)

        # Uma nota so pode herdar o numero digitado no campo geral. Varias, nao:
        # dois lancamentos com o mesmo numero nao existem, e adivinhar qual nota
        # fica com o numero digitado seria escolher no lugar de quem lanca.
        if len(notas_concluir) == 1 and not (notas_concluir[0].get("numero_pedido") or "").strip():
            notas_concluir[0]["numero_pedido"] = numped
        sem_numero = [n["numero_nf"] for n in notas_concluir
                      if not (n.get("numero_pedido") or "").strip()]
        if sem_numero:
            raise HTTPException(
                status_code=422,
                detail="Informe o número do lançamento (OV) de cada nota — falta o da NF %s."
                       % ", ".join(sem_numero),
            )
        for n in notas_concluir:
            n["numero_pedido"] = n["numero_pedido"].strip().upper()
        contagem = {}
        for n in notas_concluir:
            contagem[n["numero_pedido"]] = contagem.get(n["numero_pedido"], 0) + 1
        repetido = next((k for k, v in contagem.items() if v > 1), None)
        if repetido:
            raise HTTPException(
                status_code=422,
                detail="O número de lançamento '%s' está em duas notas — cada nota é um lançamento."
                       % repetido,
            )

        # Reabertura e baixa de empenho ainda trabalham com uma nota. Recusar e
        # melhor que faturar so a primeira e deixar as outras sumidas.
        if len(notas_concluir) > 1 and (reabrindo or payload.empenho_id):
            raise HTTPException(
                status_code=422,
                detail="Comunicado com mais de uma nota ainda não pode ser %s. "
                       "Conclua uma nota por vez." %
                       ("reaberto para correção" if reabrindo else "baixado de um empenho"),
            )

        # Os ramos de uma nota continuam lendo estes dois nomes.
        numero_nf = notas_concluir[0]["numero_nf"]
        valor_primeira = (float(payload.valor_nf) if payload.valor_nf
                          else notas_concluir[0]["valor"])
        if valor_primeira <= 0:
            raise HTTPException(
                status_code=422,
                detail="A NF %s ficou com valor zero — confira os itens." % numero_nf)

        if reabrindo:
            # Já tinha gerado o lançamento antes (demanda reaberta pra corrigir
            # algo errado) — atualiza o registro existente em vez de criar de
            # novo, senão duplica ou esbarra no "já existe lançamento com esse número".
            ped = db.table("pedidos").select("id, numero_pedido")\
                .eq("numero_pedido", d.get("gerado_ref") or numped).limit(1).execute().data
            if not ped:
                raise HTTPException(status_code=404, detail="O lançamento gerado anteriormente não foi encontrado — não dá para atualizar.")
            pid = ped[0]["id"]
            db.table("pedidos").update({
                "numero_nf": numero_nf,
                "valor_nf": valor_primeira,
                "valor_produtos": valor_primeira,
                "af": af,
                "nome_paciente": nome_paciente,
                "prontuario": prontuario,
                "data_procedimento": data_procedimento.isoformat() if data_procedimento else None,
                "canal": canal,
                "atualizado_em": _agora(),
            }).eq("id", pid).execute()
            itens_corrigidos = [it for it in itens_src if it.produto_id and float(it.qtd or 0) > 0]
            if itens_corrigidos:
                db.table("itens_pedido").delete().eq("pedido_id", pid).execute()
                db.table("itens_pedido").insert([{
                    "pedido_id": pid, "produto_id": str(it.produto_id),
                    "qtd_solicitada": float(it.qtd), "status_item": "OK",
                } for it in itens_corrigidos]).execute()
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", pid, ped[0]["numero_pedido"]
        elif payload.empenho_id:
            # Baixa saldo de um empenho consignado existente.
            licitacao_service.registrar_consumo(
                str(payload.empenho_id),
                ConsumoEmpenhoCreate(
                    numero_pedido=notas_concluir[0]["numero_pedido"],
                    numero_nf=numero_nf,
                    valor_nf=valor_primeira,
                    data_faturamento=payload.data_faturamento,
                    canal=canal,
                    itens=_itens_pedido(itens_src, "o comunicado de uso"),
                    af=af, nome_paciente=nome_paciente, prontuario=prontuario,
                    data_procedimento=data_procedimento,
                ),
                usuario,
            )
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", str(payload.empenho_id), payload.numero_pedido.strip().upper()
        else:
            # Comunicado avulso (consignado não rastreado no painel).
            #
            # Uma AF, VÁRIAS notas: cada nota vira um lançamento próprio, porque
            # `pedidos.numero_nf` é único e o faturamento conta por lançamento.
            # Uma nota só continua caindo aqui pelo mesmo caminho — a lista tem
            # um item.
            lancados = []
            for nota in notas_concluir:
                com = pedido_service.criar_comunicado_uso(
                    ComunicadoUsoCreate(
                        numero_pedido=nota["numero_pedido"],
                        cliente_id=cliente_id,
                        numero_nf=nota["numero_nf"],
                        valor_nf=nota["valor"],
                        canal=canal,
                        data_faturamento=payload.data_faturamento,
                        af=af, nome_paciente=nome_paciente, prontuario=prontuario,
                        data_procedimento=data_procedimento,
                        itens=[ItemPedidoCreate(
                            produto_id=it["produto_id"],
                            qtd_solicitada=float(it["qtd"]),
                            valor_unitario=float(it.get("valor") or 0) or None,
                        ) for it in nota["itens"]
                            if it.get("produto_id") and float(it.get("qtd") or 0) > 0],
                    ),
                    usuario,
                )
                lancados.append(com)
            # O card guarda todos; gerado_id/gerado_ref apontam para o primeiro
            # por compatibilidade com quem já lê esses campos.
            ovs_final = [{"id": c.get("id"), "numero": c.get("numero_pedido")} for c in lancados]
            gerado_tipo = "COMUNICADO"
            gerado_id = lancados[0].get("id")
            gerado_ref = ", ".join(c.get("numero_pedido") or "" for c in lancados)
    else:
        raise HTTPException(status_code=422, detail="Tipo de operação da demanda inválido.")

    update_final = {
        "etapa": etapa_final,
        "gerado_tipo": gerado_tipo,
        "gerado_id": gerado_id,
        "gerado_ref": gerado_ref,
        "cliente_id": cliente_id,
        "canal": canal,
        "numero": payload.numero.strip() if payload.numero else d.get("numero"),
        "nome_paciente": (payload.nome_paciente or "").strip() or d.get("nome_paciente"),
        "prontuario": (payload.prontuario or "").strip() or d.get("prontuario"),
        "numero_nf": (payload.numero_nf or "").strip() or d.get("numero_nf"),
        "data_procedimento": payload.data_procedimento.isoformat() if payload.data_procedimento else d.get("data_procedimento"),
        "concluido_em": _agora() if etapa_final in ETAPAS_FINAIS else None,
        "atualizado_em": _agora(),
    }
    if ovs_final is not None:
        update_final["ovs"] = ovs_final
    if tipo == "COMUNICADO_USO" and notas_concluir:
        # O card guarda as notas ja com o numero do lancamento de cada uma — e
        # assim que se sabe depois qual NF virou qual OV.
        update_final["notas"] = notas_concluir
        update_final["numero_nf"] = notas_concluir[0]["numero_nf"]
        update_final["itens"] = _itens_das_notas(notas_concluir)
    db.table("licitacao_demandas").update(update_final).eq("id", demanda_id).execute()

    return obter_demanda(demanda_id)
