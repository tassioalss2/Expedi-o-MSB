"""Previsão de Faturamento.

Junta três fontes para estimar o fechamento do mês e do dia:
  1. Realizado — NFs já faturadas no mês (mesma definição do dashboard financeiro).
  2. Em processo — OVs no pipeline ainda não faturadas (valor estimado pelos itens).
  3. Saldo de contratos ganhos — empenhos com saldo a entregar.
  4. Em negociação — negócios lançados na entrada rápida, ponderados pela chance (%).

Garantido = realizado + em processo (o que vai faturar de fato).
Saldo de contratos é "a realizar" — o órgão pede quando quer, sem data garantida.
Previsão do mês = garantido + saldo de contratos + negociação ponderada.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.enums import StatusPedido
from app.models.schemas import PrevisaoNegocioCreate, PrevisaoNegocioUpdate
from app.services import pedido_service

# OVs que já contam como faturamento por natureza (mesma regra do dashboard).
_OPERACOES_FATURAMENTO = {"VENDA_NORMAL", "COMUNICADO_USO"}

# Pipeline: OVs ativas que ainda vão faturar (não inclui finalizadas/canceladas).
_STATUS_PIPELINE = [
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
]
# Prestes a faturar (usado na previsão do dia).
_STATUS_QUASE_NF = [
    StatusPedido.EM_COTACAO_FRETE.value,
    StatusPedido.AGUARD_TRANSPORTADORA.value,
    StatusPedido.AGUARD_FATURAMENTO.value,
]

_STATUS_NEGOCIO = ["ABERTO", "GANHO", "PERDIDO"]


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conta_faturamento(tipo_operacao: Optional[str]) -> bool:
    return (tipo_operacao or "VENDA_NORMAL") in _OPERACOES_FATURAMENTO


def _valor_liquido_nf(p: dict) -> float:
    """Faturamento fiscal da NF: tira o CIF sem valor (não está na nota)."""
    nf = float(p.get("valor_nf") or 0)
    if p.get("tipo_frete") == "CIF_SEM_VALOR":
        nf -= float(p.get("valor_frete") or 0)
    return round(nf, 2)


def _eh_transfer(registro: dict) -> bool:
    """Transfer price = venda para a Biomedical (empresa do grupo). A META não
    contempla transfer price, então ele fica fora de todos os números que são
    comparados com a meta e aparece só no total consolidado.

    Mesma regra do dashboard financeiro (app/api/pedidos.py::_eh_biomedical)."""
    nome = ((registro.get("clientes") or {}).get("nome") or registro.get("cliente") or "")
    return "BIOMEDICAL" in nome.upper()


# ── CRUD dos negócios (entrada rápida) ──────────────────────────────────────────

def _serializar(n: dict) -> dict:
    cli = n.pop("clientes", None) if isinstance(n.get("clientes"), dict) else None
    n["cliente"] = (cli or {}).get("nome") or n.get("cliente_nome")
    n["valor"] = float(n.get("valor") or 0)
    n["probabilidade"] = int(n.get("probabilidade") or 0)
    n["valor_ponderado"] = round(n["valor"] * n["probabilidade"] / 100, 2)
    return n


def listar_negocios(status: Optional[str] = None) -> list:
    db = get_service_db()
    q = db.table("previsao_negocios").select("*, clientes(nome)").eq("ativo", True)
    if status:
        q = q.eq("status", status)
    rows = q.order("previsao_fechamento").execute().data
    return [_serializar(r) for r in rows]


def criar_negocio(payload: PrevisaoNegocioCreate) -> dict:
    db = get_service_db()
    row = db.table("previsao_negocios").insert({
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "cliente_nome": (payload.cliente_nome or "").strip() or None,
        "descricao": payload.descricao,
        "valor": float(payload.valor or 0),
        "probabilidade": max(0, min(100, int(payload.probabilidade or 0))),
        "previsao_fechamento": payload.previsao_fechamento.isoformat() if payload.previsao_fechamento else None,
        "canal": payload.canal,
        "observacao": payload.observacao,
        "status": "ABERTO",
        "ativo": True,
    }).execute().data[0]
    return _serializar(db.table("previsao_negocios").select("*, clientes(nome)").eq("id", row["id"]).single().execute().data)


def atualizar_negocio(negocio_id: str, payload: PrevisaoNegocioUpdate) -> dict:
    db = get_service_db()
    atual = db.table("previsao_negocios").select("id").eq("id", negocio_id).execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Negócio não encontrado")

    update: dict = {"atualizado_em": _agora()}
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.cliente_nome is not None:
        update["cliente_nome"] = payload.cliente_nome.strip() or None
    if payload.descricao is not None:
        update["descricao"] = payload.descricao
    if payload.valor is not None:
        update["valor"] = float(payload.valor)
    if payload.probabilidade is not None:
        update["probabilidade"] = max(0, min(100, int(payload.probabilidade)))
    if payload.previsao_fechamento is not None:
        update["previsao_fechamento"] = payload.previsao_fechamento.isoformat()
    if payload.canal is not None:
        update["canal"] = payload.canal
    if payload.observacao is not None:
        update["observacao"] = payload.observacao
    if payload.status is not None:
        if payload.status not in _STATUS_NEGOCIO:
            raise HTTPException(status_code=422, detail="Status inválido")
        update["status"] = payload.status
        if payload.status == "GANHO":
            update["ganho_em"] = _agora()
        elif payload.status == "PERDIDO":
            update["perdido_em"] = _agora()

    db.table("previsao_negocios").update(update).eq("id", negocio_id).execute()
    return _serializar(db.table("previsao_negocios").select("*, clientes(nome)").eq("id", negocio_id).single().execute().data)


def remover_negocio(negocio_id: str) -> dict:
    db = get_service_db()
    db.table("previsao_negocios").update({"ativo": False, "atualizado_em": _agora()}).eq("id", negocio_id).execute()
    return {"ok": True}


# ── Cálculo da previsão ─────────────────────────────────────────────────────────

def _dias_uteis(inicio: date, fim: date) -> int:
    """Dias úteis (seg–sex) de `inicio` a `fim`, inclusive. Não considera feriados."""
    if fim < inicio:
        return 0
    d, n = inicio, 0
    while d <= fim:
        if d.weekday() < 5:
            n += 1
        d += timedelta(days=1)
    return n


def _realizado_mes(db, inicio: date, fim: date) -> tuple[float, float, list]:
    """NFs faturadas no mês (BRT), líquidas, só operações de faturamento.
    Devolve (total_geral, total_transfer, itens) — geral exclui transfer price
    (a meta não o contempla); itens detalham cada OV que gerou o número."""
    janela_ini = (inicio - timedelta(days=1)).isoformat()
    janela_fim = (fim + timedelta(days=1)).isoformat()
    movs = db.table("movimentacoes").select("pedido_id, criado_em")\
        .eq("status_novo", "FATURADO")\
        .gte("criado_em", f"{janela_ini}T00:00:00")\
        .lte("criado_em", f"{janela_fim}T23:59:59").execute().data
    dia_por_ped: dict = {}
    for m in movs:
        ts_str, pid = m.get("criado_em"), m.get("pedido_id")
        if not ts_str or not pid:
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            dia = (ts.astimezone(timezone.utc) - timedelta(hours=3)).date()
        except Exception:
            continue
        if inicio <= dia <= fim:
            atual = dia_por_ped.get(pid)
            if atual is None or dia.isoformat() < atual:
                dia_por_ped[pid] = dia.isoformat()
    if not dia_por_ped:
        return 0.0, 0.0, []
    total = 0.0
    total_transfer = 0.0
    itens: list = []
    ids = list(dia_por_ped)
    for i in range(0, len(ids), 40):
        rows = db.table("pedidos").select(
            "id, numero_pedido, valor_nf, valor_frete, tipo_frete, tipo_operacao, numero_nf, clientes(nome)"
        ).in_("id", ids[i:i + 40]).execute().data
        for p in rows:
            if _conta_faturamento(p.get("tipo_operacao")):
                v = _valor_liquido_nf(p)
                transfer = _eh_transfer(p)
                if transfer:
                    total_transfer += v
                else:
                    total += v
                itens.append({
                    "numero_pedido": p.get("numero_pedido"),
                    "cliente": (p.get("clientes") or {}).get("nome"),
                    "numero_nf": p.get("numero_nf"),
                    "data": dia_por_ped.get(p["id"]),
                    "valor": v,
                    "transfer": transfer,
                })
    itens.sort(key=lambda x: x.get("data") or "", reverse=True)
    return round(total, 2), round(total_transfer, 2), itens


def _itens_por_pedido(db, ids: list) -> dict:
    """pedido_id -> valor estimado (Σ qtd_solicitada × valor_unitario)."""
    est: dict = {}
    for i in range(0, len(ids), 40):
        rows = db.table("itens_pedido").select("pedido_id, qtd_solicitada, valor_unitario")\
            .in_("pedido_id", ids[i:i + 40]).execute().data
        for it in rows:
            v = float(it.get("valor_unitario") or 0) * float(it.get("qtd_solicitada") or 0)
            est[it["pedido_id"]] = round(est.get(it["pedido_id"], 0.0) + v, 2)
    return est


def _pipeline(db) -> list:
    """OVs ativas ainda não faturadas, com valor estimado pelos itens."""
    rows = db.table("pedidos").select(
        "id, numero_pedido, status, canal, tipo_operacao, data_prevista_entrega, clientes(nome)"
    ).in_("status", _STATUS_PIPELINE).execute().data
    rows = [p for p in rows if _conta_faturamento(p.get("tipo_operacao"))]
    est = _itens_por_pedido(db, [p["id"] for p in rows]) if rows else {}
    out = []
    for p in rows:
        out.append({
            "id": p["id"],
            "numero_pedido": p.get("numero_pedido"),
            "status": p.get("status"),
            "cliente": (p.get("clientes") or {}).get("nome"),
            "canal": p.get("canal"),
            "data_prevista_entrega": p.get("data_prevista_entrega"),
            "valor_estimado": est.get(p["id"], 0.0),
            "quase_nf": p.get("status") in _STATUS_QUASE_NF,
            "transfer": _eh_transfer(p),
        })
    out.sort(key=lambda x: x.get("data_prevista_entrega") or "9999")
    return out


def _saldo_contratos(db) -> tuple[float, float, list]:
    """Σ (valor total do contrato − já faturado das OVs vinculadas), por empenho ativo.
    Devolve (saldo_geral, saldo_transfer, contratos) — geral exclui transfer price."""
    emps = db.table("empenhos").select("id, numero, numero_pregao, clientes(nome)").eq("ativo", True).execute().data
    if not emps:
        return 0.0, 0.0, []
    emp_ids = [e["id"] for e in emps]
    emp_por_id = {e["id"]: e for e in emps}

    total_contrato: dict = {}
    for i in range(0, len(emp_ids), 40):
        its = db.table("empenho_itens").select("empenho_id, qtd_empenhada, valor_unitario")\
            .in_("empenho_id", emp_ids[i:i + 40]).execute().data
        for it in its:
            v = float(it.get("qtd_empenhada") or 0) * float(it.get("valor_unitario") or 0)
            total_contrato[it["empenho_id"]] = total_contrato.get(it["empenho_id"], 0.0) + v

    faturado_por_emp: dict = {}
    for i in range(0, len(emp_ids), 40):
        peds = db.table("pedidos").select("empenho_id, valor_nf, valor_frete, tipo_frete, status")\
            .in_("empenho_id", emp_ids[i:i + 40]).execute().data
        for p in peds:
            if p.get("status") in ("FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO") and p.get("valor_nf"):
                faturado_por_emp[p["empenho_id"]] = faturado_por_emp.get(p["empenho_id"], 0.0) + _valor_liquido_nf(p)

    saldo_total = 0.0
    saldo_transfer = 0.0
    contratos: list = []
    for eid, total in total_contrato.items():
        fat = faturado_por_emp.get(eid, 0.0)
        saldo = max(0.0, total - fat)
        emp = emp_por_id.get(eid, {})
        transfer = _eh_transfer(emp)
        if transfer:
            saldo_transfer += saldo
        else:
            saldo_total += saldo
        if saldo > 0.005:
            contratos.append({
                "numero": emp.get("numero"),
                "numero_pregao": emp.get("numero_pregao"),
                "cliente": (emp.get("clientes") or {}).get("nome"),
                "total": round(total, 2),
                "faturado": round(fat, 2),
                "saldo": round(saldo, 2),
                "transfer": transfer,
            })
    contratos.sort(key=lambda x: x["saldo"], reverse=True)
    return round(saldo_total, 2), round(saldo_transfer, 2), contratos


def _dias_uteis_do_mes(inicio: date, fim: date) -> list:
    """Lista dos dias úteis do período (seg-sex)."""
    dias, d = [], inicio
    while d <= fim:
        if d.weekday() < 5:
            dias.append(d)
        d += timedelta(days=1)
    return dias


def _faturado_por_dia_app(db, inicio: date, fim: date) -> dict:
    """data ISO -> faturado no dia, só vendas gerais (sem transfer price)."""
    _, _, itens = _realizado_mes(db, inicio, fim)
    por_dia: dict = {}
    for it in itens:
        if it.get("transfer"):
            continue
        d = it.get("data")
        if d:
            por_dia[d] = round(por_dia.get(d, 0.0) + float(it.get("valor") or 0), 2)
    return por_dia


def _faturado_por_dia_import(db, inicio: date, fim: date) -> dict:
    """Mesma coisa, vindo do histórico importado (meses anteriores ao app)."""
    try:
        rows = db.table("faturamento_historico").select("data, valor, transfer")\
            .gte("data", inicio.isoformat()).lte("data", fim.isoformat()).execute().data
    except Exception:
        # Tabela ainda não migrada (v18) — degrada sem quebrar a previsão.
        return {}
    por_dia: dict = {}
    for r in rows:
        if r.get("transfer"):
            continue
        d = r.get("data")
        if d:
            por_dia[d] = round(por_dia.get(d, 0.0) + float(r.get("valor") or 0), 2)
    return por_dia


def _meses_historicos(db, mes_atual_inicio: date, n_meses: int = 24) -> list:
    """Meses COMPLETOS antes do atual, cada um com o total e a curva acumulada
    por dia útil.

    O histórico importado (D365) tem prioridade sobre o app: é a fonte fiscal, e
    os primeiros meses do app estão incompletos porque ele começou a ser usado no
    meio da operação (06/2026 tem notas que o app não registrou). O app cobre os
    meses que a importação não alcança. Nunca soma as duas fontes no mesmo mês —
    isso dobraria valor."""
    # Janela do histórico: n_meses antes do mês atual até o fim do mês passado.
    fim_janela = mes_atual_inicio - timedelta(days=1)
    ini_janela = mes_atual_inicio
    for _ in range(n_meses):
        anterior = ini_janela - timedelta(days=1)
        ini_janela = date(anterior.year, anterior.month, 1)

    # Duas consultas para toda a janela, em vez de duas por mês.
    imp = _faturado_por_dia_import(db, ini_janela, fim_janela)
    app = _faturado_por_dia_app(db, ini_janela, fim_janela)

    def _por_competencia(por_dia: dict) -> dict:
        agrupado: dict = {}
        for d_iso, v in por_dia.items():
            agrupado.setdefault(d_iso[:7], {})[d_iso] = v
        return agrupado

    imp_mes, app_mes = _por_competencia(imp), _por_competencia(app)

    meses: list = []
    for comp in sorted(set(imp_mes) | set(app_mes)):
        if comp in imp_mes:
            por_dia, origem = imp_mes[comp], "HISTORICO"
        else:
            por_dia, origem = app_mes[comp], "APP"
        total = round(sum(por_dia.values()), 2)
        if total <= 0:
            continue

        ano, mes_num = int(comp[:4]), int(comp[5:7])
        ini = date(ano, mes_num, 1)
        fim = date(ano + (mes_num // 12), (mes_num % 12) + 1, 1) - timedelta(days=1)
        acumulado, soma = [], 0.0
        for d in _dias_uteis_do_mes(ini, fim):
            soma += por_dia.get(d.isoformat(), 0.0)
            acumulado.append(round(soma, 2))
        meses.append({
            "competencia": comp,
            "total": total,
            "acumulado": acumulado,
            "dias_uteis": len(acumulado),
            "origem": origem,
        })
    return meses


def _fracao_esperada(meses: list, progresso: float) -> tuple:
    """Fração do total do mês que costuma estar faturada quando `progresso`
    (0..1) dos dias úteis já passou. Os meses têm quantidades diferentes de dias
    úteis, então a comparação é pelo progresso relativo, não pelo dia absoluto.
    Devolve (fracao_media, qtd_meses_usados)."""
    fracoes = []
    for m in meses:
        acum, total = m["acumulado"], m["total"]
        n = len(acum)
        if n == 0 or total <= 0:
            continue
        idx = min(n - 1, max(0, int(round(progresso * n)) - 1))
        fracoes.append(acum[idx] / total)
    if not fracoes:
        return None, 0
    return sum(fracoes) / len(fracoes), len(fracoes)


def _erro_historico(meses: list, progresso: float, peso_curva: float) -> tuple:
    """Backtest leave-one-out: reprojeta cada mês do histórico nesta mesma altura
    usando só os OUTROS meses como base, e mede o erro contra o total real.

    É daqui que sai a faixa da previsão — erro medido, não chutado. Devolve
    (erro_medio_pct, qtd_meses_testados)."""
    erros = []
    for alvo in meses:
        base = [m for m in meses if m["competencia"] != alvo["competencia"]]
        acum, total = alvo["acumulado"], alvo["total"]
        n = len(acum)
        if n == 0 or total <= 0:
            continue
        idx = min(n - 1, max(0, int(round(progresso * n)) - 1))
        realizado = acum[idx]
        decorridos, futuros = idx + 1, n - (idx + 1)
        proj_rr = realizado + (realizado / decorridos) * futuros
        frac, _ = _fracao_esperada(base, progresso)
        if frac and frac >= 0.10:
            proj = (proj_rr + (realizado / frac) * peso_curva) / (1 + peso_curva)
        else:
            proj = proj_rr
        erros.append(abs(proj - total) / total * 100)
    if not erros:
        return None, 0
    return round(sum(erros) / len(erros), 1), len(erros)


def _previsao_estatistica(db, hoje: date, inicio: date, fim: date, realizado: float,
                          garantido: float) -> dict:
    """Projeta o fechamento do mês por estatística, sem usar saldo de contratos
    (que é esporádico e sem data — não dá para prever).

    Dois métodos, combinados por peso conforme o histórico disponível:
      1. Run-rate do próprio mês — média diária até agora × dias que faltam.
         Sempre disponível, mas ignora que o mês costuma ser desigual.
      2. Curva de ritmo histórica — se historicamente X% do mês já estava
         faturado a esta altura, o total projetado é realizado ÷ X%.
         Precisa de histórico; quanto mais meses, mais peso.
    O piso é o garantido (realizado + OVs em processo), que é quase certo."""
    dias_totais = len(_dias_uteis_do_mes(inicio, fim))
    dias_decorridos = len(_dias_uteis_do_mes(inicio, min(hoje, fim)))
    dias_futuros = max(0, dias_totais - dias_decorridos)
    progresso = (dias_decorridos / dias_totais) if dias_totais else 0.0

    meses = _meses_historicos(db, inicio)

    run_rate = round(realizado / dias_decorridos, 2) if dias_decorridos else 0.0
    proj_run_rate = round(realizado + run_rate * dias_futuros, 2)

    fracao, amostra = _fracao_esperada(meses, progresso)
    # Fração muito baixa (início do mês) dispara projeções absurdas — só usa a
    # curva quando já há base suficiente para dividir.
    proj_curva = round(realizado / fracao, 2) if (fracao and fracao >= 0.10) else None

    media_hist = round(sum(m["total"] for m in meses) / len(meses), 2) if meses else None

    # Peso da curva cresce com a amostra: o backtest mostra que, da metade do mês
    # em diante, ela erra bem menos que o run-rate (16,8% x 28,5% a 82% do mês).
    peso_curva = min(3.0, float(amostra))
    candidatos = [("run_rate", proj_run_rate, 1.0)]
    if proj_curva is not None:
        candidatos.append(("curva_historica", proj_curva, peso_curva))

    peso_total = sum(p for _, _, p in candidatos)
    previsao = round(sum(v * p for _, v, p in candidatos) / peso_total, 2)
    previsao = max(previsao, round(garantido, 2))

    # Faixa a partir do erro medido no histórico, não de chute. O piso nunca fica
    # abaixo do garantido (esse dinheiro já está em NF ou em OV no pipeline).
    erro_pct, testados = _erro_historico(meses, progresso, peso_curva)
    if erro_pct:
        minimo = max(round(previsao * (1 - erro_pct / 100), 2), round(garantido, 2))
        maximo = round(previsao * (1 + erro_pct / 100), 2)
    else:
        valores = [v for _, v, _ in candidatos] + [garantido]
        minimo, maximo = round(min(valores), 2), round(max(valores), 2)

    if amostra >= 6:
        confianca = "ALTA"
    elif amostra >= 2:
        confianca = "MEDIA"
    else:
        confianca = "BAIXA"

    return {
        "previsao": previsao,
        "minimo": minimo,
        "maximo": maximo,
        "erro_medio_pct": erro_pct,
        "backtest_meses": testados,
        "metodo": "+".join(n for n, _, _ in candidatos),
        "confianca": confianca,
        "amostra_meses": amostra,
        "run_rate_diario": run_rate,
        "projecao_run_rate": proj_run_rate,
        "projecao_curva": proj_curva,
        "fracao_esperada_pct": round(fracao * 100, 1) if fracao else None,
        "media_historica": media_hist,
        "dias_uteis_total": dias_totais,
        "dias_uteis_decorridos": dias_decorridos,
        "dias_uteis_futuros": dias_futuros,
        "progresso_pct": round(progresso * 100, 1),
        "meses": [{"competencia": m["competencia"], "total": m["total"], "origem": m["origem"]} for m in meses],
    }


def resumo() -> dict:
    db = get_service_db()
    hoje = date.today()
    inicio = date(hoje.year, hoje.month, 1)
    fim = date(hoje.year + (hoje.month // 12), (hoje.month % 12) + 1, 1) - timedelta(days=1)
    comp = f"{hoje.year:04d}-{hoje.month:02d}"

    # Tudo abaixo é SEM transfer price (a meta não o contempla). O transfer price
    # é somado à parte e aparece apenas no consolidado (`com_transfer`).
    realizado, realizado_transfer, realizado_itens = _realizado_mes(db, inicio, fim)
    pipeline = _pipeline(db)
    em_processo_total = round(sum(p["valor_estimado"] for p in pipeline if not p["transfer"]), 2)
    em_processo_transfer = round(sum(p["valor_estimado"] for p in pipeline if p["transfer"]), 2)
    saldo_contratos, saldo_contratos_transfer, contratos = _saldo_contratos(db)
    # Garantido = só o que vai faturar de fato: NFs do mês + OVs no pipeline.
    # Saldo de contratos NÃO entra (o órgão pede quando quer — sem data garantida).
    garantido = round(realizado + em_processo_total, 2)

    try:
        negocios = listar_negocios("ABERTO")
    except Exception:
        # Tabela ainda não migrada — degrada sem quebrar o resto da previsão.
        negocios = []
    hoje_iso, fim_iso = hoje.isoformat(), fim.isoformat()

    def _no_mes(n: dict) -> bool:
        pf = n.get("previsao_fechamento")
        return (not pf) or (pf <= fim_iso)

    neg_mes = [n for n in negocios if _no_mes(n)]
    negociacao_bruto = round(sum(n["valor"] for n in neg_mes), 2)
    negociacao_ponderado = round(sum(n["valor_ponderado"] for n in neg_mes), 2)
    # "Real" = o que está no app + negociação ponderada. O saldo de contratos NÃO
    # entra: é esporádico e sem data (o órgão pede quando quer), então serve só
    # como potencial informativo — não como previsão.
    real_no_app = round(garantido + negociacao_ponderado, 2)
    # Previsão = projeção estatística (run-rate do mês + curva de ritmo histórica),
    # com piso no real do app.
    estatistica = _previsao_estatistica(db, hoje, inicio, fim, realizado, real_no_app)
    previsao_mes = estatistica["previsao"]

    # Previsão do dia — duas visões, ambas somando o que JÁ faturou hoje (senão
    # o dia parece "abaixo do ritmo" mesmo depois de já ter batido a meta):
    #  sai_hoje  = já faturado hoje + OVs prestes a faturar (quase-NF) +
    #              negócios de hoje (o que realisticamente deve sair hoje);
    #  no_kanban = já faturado hoje + TODO o pipeline + negócios de hoje (volume
    #              total do dia, usado para checar se bate o ritmo).
    realizado_hoje, realizado_hoje_transfer, _ = _realizado_mes(db, hoje, hoje)
    quase_nf = round(sum(p["valor_estimado"] for p in pipeline if p["quase_nf"] and not p["transfer"]), 2)
    quase_nf_transfer = round(sum(p["valor_estimado"] for p in pipeline if p["quase_nf"] and p["transfer"]), 2)
    neg_hoje = round(sum(n["valor_ponderado"] for n in negocios if n.get("previsao_fechamento") == hoje_iso), 2)
    sai_hoje = round(realizado_hoje + quase_nf + neg_hoje, 2)
    no_kanban = round(realizado_hoje + em_processo_total + neg_hoje, 2)
    sai_hoje_transfer = round(realizado_hoje_transfer + quase_nf_transfer, 2)
    no_kanban_transfer = round(realizado_hoje_transfer + em_processo_transfer, 2)

    meta_info = pedido_service.obter_meta(comp)
    meta = meta_info.get("valor")
    dias_restantes = _dias_uteis(hoje, fim)
    falta = round(max(0.0, meta - realizado), 2) if meta else None
    ritmo_necessario = round(falta / dias_restantes, 2) if (falta is not None and dias_restantes > 0) else None

    return {
        "competencia": comp,
        "hoje": hoje_iso,
        "mes": {
            "realizado": realizado,
            "em_processo": em_processo_total,
            "saldo_contratos": saldo_contratos,
            "garantido": garantido,
            "negociacao_bruto": negociacao_bruto,
            "negociacao_ponderado": negociacao_ponderado,
            "real_no_app": real_no_app,
            "previsao": previsao_mes,
            "meta": meta,
            "atingimento_previsto_pct": round(previsao_mes / meta * 100, 1) if meta else None,
            "atingimento_real_pct": round(real_no_app / meta * 100, 1) if meta else None,
        },
        "estatistica": estatistica,
        # Transfer price (vendas para a Biomedical) — fora da meta, isolado aqui.
        "transfer": {
            "realizado": realizado_transfer,
            "em_processo": em_processo_transfer,
            "saldo_contratos": saldo_contratos_transfer,
            "garantido": round(realizado_transfer + em_processo_transfer, 2),
            # Sem saldo de contratos: esporádico e sem data, não é previsível.
            "previsao": round(realizado_transfer + em_processo_transfer, 2),
            "realizado_hoje": realizado_hoje_transfer,
            "sai_hoje": sai_hoje_transfer,
            "no_kanban": no_kanban_transfer,
        },
        # Consolidado: vendas gerais + transfer price (volume total da operação).
        "com_transfer": {
            "realizado": round(realizado + realizado_transfer, 2),
            "em_processo": round(em_processo_total + em_processo_transfer, 2),
            "saldo_contratos": round(saldo_contratos + saldo_contratos_transfer, 2),
            "garantido": round(garantido + realizado_transfer + em_processo_transfer, 2),
            "previsao": round(previsao_mes + realizado_transfer + em_processo_transfer, 2),
            "realizado_hoje": round(realizado_hoje + realizado_hoje_transfer, 2),
            "sai_hoje": round(sai_hoje + sai_hoje_transfer, 2),
            "no_kanban": round(no_kanban + no_kanban_transfer, 2),
        },
        "dia": {
            "sai_hoje": sai_hoje,
            "no_kanban": no_kanban,
            "realizado_hoje": realizado_hoje,
            "ovs_kanban": em_processo_total,
            "quase_nf": quase_nf,
            "negociacao_hoje": neg_hoje,
            "dias_uteis_restantes": dias_restantes,
            "falta_meta": falta,
            "ritmo_necessario": ritmo_necessario,
            # Sinal: há volume no kanban suficiente para cobrir o ritmo do dia?
            "no_ritmo": (no_kanban >= ritmo_necessario) if ritmo_necessario is not None else None,
        },
        "pipeline": pipeline,
        "negocios": negocios,
        "realizado_itens": realizado_itens,
        "contratos": contratos,
    }
