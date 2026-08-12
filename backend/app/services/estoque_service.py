"""Estoque disponível: foto do PCP de manhã, descontando as OVs do nosso app.

O PCP atualiza o estoque uma vez ao dia (planilha do D365 -> app deles). O nosso
app precisa mostrar o estoque ao longo do dia, então:

    disponível = foto do PCP (manhã) − comprometido pelas OVs

E o comprometido é sempre RECALCULADO das OVs reais, nunca decrementado num
saldo guardado. Saldo mutável acumula desvio e não dá para auditar; recalculando,
o número se autocorrige e a foto da manhã seguinte zera qualquer resíduo.

Quais OVs contam como comprometido
----------------------------------
Descoberto cruzando 3.836 OVs com saída física do D365 contra os status daqui: o
D365 baixa o estoque no FATURAMENTO (antes disso o material continua fisicamente
no estoque; LIBERADO/EM_COTACAO_FRETE apareceram com 0 baixas, EXPEDIDO com 249).

Então conta como comprometido toda OV não cancelada que:
  a) ainda não faturou — o material está na foto do PCP e já tem dono; ou
  b) faturou DEPOIS da foto — estava na foto de hoje e já saiu.

Sem o item (b) o número ficaria otimista durante o dia: material faturado hoje
saiu do estoque, mas a foto da manhã ainda o continha.

O que NÃO conta: OV cancelada, e OV que já havia faturado ANTES da foto — essa
o PCP já descontou, contar de novo seria baixa dupla.
"""
import time
from datetime import date, datetime, timedelta, timezone

from app.core.database import get_service_db
from app.services import linha_produto, pcp_estoque_service

# Status em que o material ainda está fisicamente no estoque (o D365 só baixa no
# faturamento). BLOQUEADO entra: o material continua lá e segue reservado.
# AGUARD_DADOS_OV entra: é a OV que nasce da venda ganha no CRM ou da venda
# outbound, esperando só o número real do D365. O material já tem dono desde o
# instante do ganho. Estava de fora — 128 unidades vendidas apareciam como
# disponíveis para vender de novo, e a conferência de estoque da venda ficaria
# prometendo material já comprometido.
_STATUS_ABERTOS = [
    "AGUARD_DADOS_OV",
    "AGUARD_CREDITO", "LIBERADO", "EM_INVENTARIO", "AGUARD_VERIFICACAO",
    "DIVERGENCIA", "AGUARD_TRATATIVA", "EM_PROCESSO_SISTEMICO",
    "EM_COTACAO_FRETE", "AGUARD_TRANSPORTADORA", "AGUARD_FATURAMENTO",
    "BLOQUEADO",
]
# Já saiu do estoque físico.
_STATUS_FATURADOS = ["FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO"]

_FAIXA_CRITICO, _FAIXA_ATENCAO, _FAIXA_ADEQUADO, _FAIXA_ALTO = 1.0, 2.0, 6.0, 12.0

# A view do PCP (pa_coverage) não tem coluna "linha" — só família. A linha vem
# do cadastro do produto (produtos.linha), com fallback por família; ver
# app/services/linha_produto.py.
def _linha_do_item(codigo, familia, por_codigo: dict) -> str:
    # Sem correspondência nem no cadastro nem no mapa de família: cai em
    # "Outros" em vez de sumir da lista.
    return linha_produto.label(linha_produto.resolver(codigo, familia, por_codigo))


def _hoje_brt() -> date:
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _status_cobertura(cobertura, consumo_medio: float) -> str:
    if consumo_medio <= 0 or cobertura is None:
        return "SEM_GIRO"
    if cobertura < _FAIXA_CRITICO:
        return "CRITICO"
    if cobertura < _FAIXA_ATENCAO:
        return "ATENCAO"
    if cobertura < _FAIXA_ADEQUADO:
        return "ADEQUADO"
    if cobertura < _FAIXA_ALTO:
        return "ALTO"
    return "EXCESSIVO"


# ── Sincronização da foto do PCP ────────────────────────────────────────────────

def _snapshot_do_dia(db, dia: date) -> list:
    try:
        return db.table("estoque_pcp_snapshot").select("*").eq("data_ref", dia.isoformat()).execute().data
    except Exception:
        # Tabela ainda não migrada (v19) — degrada sem quebrar a tela.
        return []


def _tem_coluna_historico(db) -> bool:
    """Se a v20 já rodou. Checado ANTES de inserir: descobrir pelo erro no meio
    dos lotes deixaria a foto do dia gravada pela metade."""
    try:
        db.table("estoque_pcp_snapshot").select("sales_history").limit(1).execute()
        return True
    except Exception:
        return False


def _inserir_snapshot(db, linhas: list) -> None:
    """Grava a foto. Sem a coluna sales_history (v20 não rodada) grava sem ela —
    o estoque é o essencial, o histórico do PCP é o extra."""
    if not _tem_coluna_historico(db):
        linhas = [{k: v for k, v in linha.items() if k != "sales_history"} for linha in linhas]
    for i in range(0, len(linhas), 200):
        db.table("estoque_pcp_snapshot").insert(linhas[i:i + 200]).execute()


def sincronizar(forcar: bool = False) -> dict:
    """Grava a foto do PCP do dia. Idempotente: se já existe foto de hoje e
    `forcar` é falso, não faz nada (a primeira abertura do dia sincroniza; o
    botão 'Sincronizar agora' passa forcar=True)."""
    db = get_service_db()
    dia = _hoje_brt()

    existente = _snapshot_do_dia(db, dia)
    if existente and not forcar:
        return {"sincronizou": False, "motivo": "ja_sincronizado_hoje",
                "itens": len(existente), "data_ref": dia.isoformat()}

    if not pcp_estoque_service.integracao_ativa():
        return {"sincronizou": False, "motivo": "integracao_desligada", "itens": 0,
                "data_ref": dia.isoformat()}

    dados = pcp_estoque_service.buscar_cobertura_pcp()
    if not dados:
        # PCP fora do ar: mantém a foto anterior em vez de gravar uma vazia.
        return {"sincronizou": False, "motivo": "pcp_indisponivel",
                "itens": len(existente), "data_ref": dia.isoformat()}

    agora = datetime.now(timezone.utc).isoformat()
    linhas = [{
        "data_ref": dia.isoformat(),
        "codigo": c["codigo"],
        "descricao": c.get("descricao"),
        "familia": c.get("familia"),
        "estoque_pa": c.get("estoque") or 0,
        "estoque_sa": c.get("estoque_sa") or 0,
        "estoque_total": c.get("estoque_total") or 0,
        "consumo_medio": c.get("consumo_medio") or 0,
        "cobertura_meses": c.get("cobertura_meses"),
        "sales_history": c.get("sales_history") or {},
        "sincronizado_em": agora,
    } for c in dados.values() if c.get("codigo")]

    try:
        if existente:
            # Re-sincronização do mesmo dia: troca a foto (unique data_ref+codigo).
            db.table("estoque_pcp_snapshot").delete().eq("data_ref", dia.isoformat()).execute()
        _inserir_snapshot(db, linhas)
    except Exception:
        # Tabela ainda não migrada (v19).
        return {"sincronizou": False, "motivo": "tabela_ausente", "itens": 0,
                "data_ref": dia.isoformat()}

    return {"sincronizou": True, "motivo": None, "itens": len(linhas),
            "data_ref": dia.isoformat(), "sincronizado_em": agora}


# ── Comprometido pelas OVs ──────────────────────────────────────────────────────

def _ts_para_filtro(momento: str) -> str:
    """Timestamp em formato seguro para a query string. O offset '+00:00' quebra
    o filtro (o '+' não é escapado e o PostgREST lê como espaço), então usa 'Z'."""
    if not momento:
        return ""
    try:
        dt = datetime.fromisoformat(momento.replace("Z", "+00:00"))
    except Exception:
        return momento.split("+")[0]
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + "Z"


def _ovs_faturadas_apos(db, momento: str) -> list:
    """pedido_ids que passaram para FATURADO depois da foto — estavam nela e já
    saíram, então ainda contam como baixa do dia."""
    filtro = _ts_para_filtro(momento)
    if not filtro:
        return []
    movs = db.table("movimentacoes").select("pedido_id, criado_em")\
        .eq("status_novo", "FATURADO").gte("criado_em", filtro).execute().data
    return list({m["pedido_id"] for m in movs if m.get("pedido_id")})


def _comprometido_por_produto(db, sincronizado_em: str) -> dict:
    """produto_id -> qtd comprometida (ver regra no docstring do módulo)."""
    ids = set()
    for i in range(0, len(_STATUS_ABERTOS), 10):
        lote = _STATUS_ABERTOS[i:i + 10]
        for p in db.table("pedidos").select("id").in_("status", lote).execute().data:
            ids.add(p["id"])
    ids.update(_ovs_faturadas_apos(db, sincronizado_em))
    if not ids:
        return {}

    ids = list(ids)
    comprometido: dict = {}
    for i in range(0, len(ids), 40):
        itens = db.table("itens_pedido").select("produto_id, qtd_solicitada")\
            .in_("pedido_id", ids[i:i + 40]).execute().data
        for it in itens:
            pid = it.get("produto_id")
            if pid:
                comprometido[pid] = comprometido.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)
    return comprometido


def _codigo_por_produto_id(db) -> dict:
    """produto_id -> codigo. O cruzamento com o PCP é pelo código do produto."""
    prods = db.table("produtos").select("id, codigo").execute().data
    return {p["id"]: (p.get("codigo") or "").strip().upper() for p in prods if p.get("codigo")}


def comprometido_detalhe(codigo: str) -> dict:
    """As OVs por trás do número de 'comprometido' de um código — para o usuário
    clicar e ver de onde vem, em vez de confiar cegamente na conta."""
    db = get_service_db()
    cod = (codigo or "").strip().upper()

    produtos = db.table("produtos").select("id").ilike("codigo", cod).execute().data
    produto_ids = [p["id"] for p in produtos]
    if not produto_ids:
        return {"codigo": codigo, "ovs": []}

    dia = _hoje_brt()
    snapshot = _snapshot_do_dia(db, dia)
    if not snapshot:
        ultimas = db.table("estoque_pcp_snapshot").select("data_ref")\
            .order("data_ref", desc=True).limit(1).execute().data
        if ultimas:
            snapshot = _snapshot_do_dia(db, date.fromisoformat(ultimas[0]["data_ref"]))
    sincronizado_em = snapshot[0].get("sincronizado_em") if snapshot else None

    ids_abertos = set()
    for i in range(0, len(_STATUS_ABERTOS), 10):
        lote = _STATUS_ABERTOS[i:i + 10]
        for p in db.table("pedidos").select("id").in_("status", lote).execute().data:
            ids_abertos.add(p["id"])
    ids_faturados_depois = set(_ovs_faturadas_apos(db, sincronizado_em))
    ids_relevantes = ids_abertos | ids_faturados_depois
    if not ids_relevantes:
        return {"codigo": codigo, "ovs": []}

    itens = []
    for i in range(0, len(produto_ids), 40):
        lote = produto_ids[i:i + 40]
        itens += db.table("itens_pedido").select("pedido_id, qtd_solicitada")\
            .in_("produto_id", lote).execute().data
    pedido_ids = [it["pedido_id"] for it in itens if it.get("pedido_id") in ids_relevantes]
    if not pedido_ids:
        return {"codigo": codigo, "ovs": []}

    qtd_por_pedido: dict = {}
    for it in itens:
        pid = it.get("pedido_id")
        if pid in ids_relevantes:
            qtd_por_pedido[pid] = qtd_por_pedido.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)

    pedidos = []
    for i in range(0, len(pedido_ids), 40):
        pedidos += db.table("pedidos").select("id, numero_pedido, status, cliente_id, criado_em")\
            .in_("id", pedido_ids[i:i + 40]).execute().data
    cliente_ids = list({p["cliente_id"] for p in pedidos if p.get("cliente_id")})
    clientes = {}
    for i in range(0, len(cliente_ids), 40):
        for c in db.table("clientes").select("id, nome").in_("id", cliente_ids[i:i + 40]).execute().data:
            clientes[c["id"]] = c.get("nome")

    ovs = [{
        "pedido_id": p["id"],
        "numero_pedido": p.get("numero_pedido"),
        "status": p.get("status"),
        "cliente": clientes.get(p.get("cliente_id")),
        "qtd": round(qtd_por_pedido.get(p["id"], 0.0)),
        "criado_em": p.get("criado_em"),
        "faturada_depois_da_foto": p.get("status") not in _STATUS_ABERTOS,
    } for p in pedidos]
    ovs.sort(key=lambda o: o["criado_em"] or "", reverse=True)
    return {"codigo": codigo, "ovs": ovs}


# ── Histórico de vendas e tendência ─────────────────────────────────────────────
#
# O histórico mensal vem do PCP (pa_products.sales_history, do D365) porque tem
# 6 meses fechados — o nosso app só existe desde 29/05/2026. A tendência compara
# os 3 últimos meses fechados com os 3 anteriores, que é o mesmo período da média
# de consumo e amortece a variação mês a mês (compra de licitação num mês só).
#
# O mês CORRENTE não está no histórico do PCP (eles importam mês fechado), então
# o acumulado do mês em curso é calculado das OVs faturadas daqui — é a fonte que
# sabe o que aconteceu hoje. Nunca soma as duas: o PCP cobre meses fechados, o
# app cobre o mês em curso.


def _meses_ate(fim_mes: str, quantidade: int) -> list:
    """['AAAA-MM', ...] terminando em fim_mes (inclusive), do mais antigo ao mais
    recente."""
    ano, mes = int(fim_mes[:4]), int(fim_mes[5:7])
    chaves = []
    for _ in range(quantidade):
        chaves.append(f"{ano:04d}-{mes:02d}")
        mes -= 1
        if mes < 1:
            mes = 12
            ano -= 1
    return list(reversed(chaves))


def _mes_anterior(mes_ref: str) -> str:
    ano, mes = int(mes_ref[:4]), int(mes_ref[5:7])
    mes -= 1
    if mes < 1:
        mes, ano = 12, ano - 1
    return f"{ano:04d}-{mes:02d}"


def _tendencia_do_historico(historico: dict, ultimo_mes: str) -> tuple:
    """Compara os 3 meses fechados até ultimo_mes com os 3 anteriores. Devolve
    (media_recente, media_anterior, pct). pct é None sem base de comparação —
    item novo ou parado, onde qualquer percentual seria invenção."""
    if not historico:
        return None, None, None
    recentes = _meses_ate(ultimo_mes, 3)
    anteriores = _meses_ate(_meses_ate(ultimo_mes, 3)[0], 4)[:3]

    def media(chaves):
        # Mês ausente no histórico = sem venda no mês, conta como zero: o PCP só
        # inclui a chave quando houve movimento.
        return sum(float(historico.get(k) or 0) for k in chaves) / len(chaves)

    m_rec, m_ant = media(recentes), media(anteriores)
    if m_ant <= 0:
        return round(m_rec, 1), round(m_ant, 1), None
    return round(m_rec, 1), round(m_ant, 1), round((m_rec - m_ant) / m_ant * 100)


def _ultimo_mes_fechado(historicos: list) -> str:
    """O mês FECHADO mais recente do histórico do PCP.

    Vem do dado em vez de ser calculado do calendário: se eles atrasarem a
    importação, a tendência acompanha o que existe em vez de comparar contra
    meses vazios. Mas nunca passa do mês anterior — o PCP manda o mês corrente
    parcial no sales_history, e incluir 5 dias de agosto como se fossem um mês
    inteiro derrubava a média recente e chegava a inverter o sinal da
    tendência (item estável aparecendo com -30%)."""
    limite = _mes_anterior(_hoje_brt().strftime("%Y-%m"))
    chaves = {k for h in historicos if h for k in h if k <= limite}
    if chaves:
        return max(chaves)
    return limite


def _vendido_no_mes_por_codigo(db, mes_ref: str) -> dict:
    """codigo -> qtd faturada no mês corrente, das OVs daqui. Mesmo corte do
    comprometido: conta pela data em que a OV virou FATURADO."""
    inicio = datetime(int(mes_ref[:4]), int(mes_ref[5:7]), 1, tzinfo=timezone.utc)
    movs = db.table("movimentacoes").select("pedido_id, criado_em")        .eq("status_novo", "FATURADO").gte("criado_em", _ts_para_filtro(inicio.isoformat())).execute().data
    # Uma OV pode ter várias movimentações para FATURADO (correção de status);
    # a primeira é a que marca a saída.
    data_por_pedido: dict = {}
    for m in movs:
        pid, d = m.get("pedido_id"), m.get("criado_em")
        if pid and d and (pid not in data_por_pedido or d < data_por_pedido[pid]):
            data_por_pedido[pid] = d
    if not data_por_pedido:
        return {}

    pedido_ids = list(data_por_pedido.keys())
    itens = []
    for i in range(0, len(pedido_ids), 40):
        itens += db.table("itens_pedido").select("pedido_id, produto_id, qtd_solicitada")            .in_("pedido_id", pedido_ids[i:i + 40]).execute().data

    cod_por_pid = _codigo_por_produto_id(db)
    out: dict = {}
    for it in itens:
        cod = cod_por_pid.get(it.get("produto_id"))
        if cod and it.get("pedido_id") in data_por_pedido:
            out[cod] = out.get(cod, 0.0) + float(it.get("qtd_solicitada") or 0)
    return out


def historico_vendas(codigo: str) -> dict:
    """Histórico mensal do PCP (6 meses fechados) + o acumulado do mês corrente
    calculado das OVs daqui, para o modal do item."""
    db = get_service_db()
    cod = (codigo or "").strip().upper()

    mes_atual = _hoje_brt().strftime("%Y-%m")
    vazio = {"codigo": codigo, "descricao": None, "meses": [], "total_fechado": 0,
             "consumo_medio": None, "cobertura_atual": None, "tendencia_pct": None,
             "media_3m": None, "media_3m_anterior": None,
             "vendido_mes_atual": 0, "mes_atual": mes_atual}

    dia = _hoje_brt()
    snapshot = _snapshot_do_dia(db, dia)
    if not snapshot:
        try:
            ultimas = db.table("estoque_pcp_snapshot").select("data_ref")\
                .order("data_ref", desc=True).limit(1).execute().data
        except Exception:
            ultimas = []
        if not ultimas:
            return vazio
        snapshot = _snapshot_do_dia(db, date.fromisoformat(ultimas[0]["data_ref"]))

    row = next((r for r in snapshot if (r.get("codigo") or "").strip().upper() == cod), None)
    if not row:
        return vazio

    historico = row.get("sales_history") or {}
    ultimo_fechado = _ultimo_mes_fechado([r.get("sales_history") for r in snapshot])
    meses = [{"mes": k, "qtd": round(float(historico.get(k) or 0))} for k in _meses_ate(ultimo_fechado, 6)]
    media_3m, media_3m_ant, tendencia_pct = _tendencia_do_historico(historico, ultimo_fechado)

    consumo = float(row.get("consumo_medio") or 0)
    comprometido = _comprometido_por_produto(db, row.get("sincronizado_em"))
    cod_por_pid = _codigo_por_produto_id(db)
    comp = sum(q for pid, q in comprometido.items() if cod_por_pid.get(pid) == cod)
    disponivel = float(row.get("estoque_pa") or 0) - comp
    sa = float(row.get("estoque_sa") or 0)

    return {
        "codigo": row.get("codigo"),
        "descricao": row.get("descricao"),
        "meses": meses,
        "total_fechado": round(sum(m["qtd"] for m in meses)),
        "consumo_medio": round(consumo, 1),
        "cobertura_atual": round((disponivel + sa) / consumo, 1) if consumo > 0 else None,
        "tendencia_pct": tendencia_pct,
        "media_3m": media_3m,
        "media_3m_anterior": media_3m_ant,
        "vendido_mes_atual": round(_vendido_no_mes_por_codigo(db, mes_atual).get(cod, 0.0)),
        "mes_atual": mes_atual,
    }


# ── Consulta ────────────────────────────────────────────────────────────────────

def disponivel_por_codigo() -> dict:
    """{codigo: {disponivel, estoque_sa, descricao}} para o seletor de itens.

    Não sincroniza com o PCP: quem escolhe um produto numa lista não pode esperar
    um round trip. A foto da manhã com o comprometido descontado em tempo real já
    responde "tem ou não tem", e a decisão que VINCULA (o ganho da venda) refaz a
    conta com sincronização.
    """
    dados = listar(sincronizar_se_preciso=False)
    return {
        "itens": {
            (i.get("codigo") or "").strip().upper(): {
                "disponivel": i.get("disponivel"),
                "estoque_sa": i.get("estoque_sa"),
                "descricao": i.get("descricao"),
            }
            for i in (dados.get("itens") or []) if i.get("codigo")
        },
        "data_ref": dados.get("data_ref"),
        "desatualizado": dados.get("desatualizado"),
    }


# Montar o estoque custa alguns segundos: o comprometido é recalculado varrendo
# as OVs abertas, e o vendido no mês, as faturadas. Vale a pena e não vai virar
# saldo guardado (ver o topo do módulo) — mas telas que só EXIBEM chamam isto a
# cada refetch, e a coluna de pendências do CRM recarrega a cada 30s.
#
# Então o caminho "só exibição" (sincronizar_se_preciso=False) reaproveita o
# último resultado por alguns segundos. Quem VINCULA decisão passa True, faz o
# round trip no PCP e nunca lê daqui.
# 2 min: a foto do PCP muda UMA VEZ AO DIA, e o que varia no meio do dia é o
# comprometido pelas OVs. Segurar por 2 minutos não muda decisão nenhuma, e é
# maior que o refetch de 30s da coluna — senão metade das chamadas pagaria tudo
# de novo.
_CACHE_EXIBICAO: dict = {"em": 0.0, "dados": None}
_CACHE_SEGUNDOS = 120


def listar(sincronizar_se_preciso: bool = True) -> dict:
    """Estoque disponível por item: foto do PCP menos o comprometido pelas OVs."""
    if not sincronizar_se_preciso:
        cache = _CACHE_EXIBICAO
        if cache["dados"] is not None and (time.monotonic() - cache["em"]) < _CACHE_SEGUNDOS:
            return cache["dados"]

    db = get_service_db()
    dia = _hoje_brt()

    sync = None
    if sincronizar_se_preciso:
        sync = sincronizar()

    snapshot = _snapshot_do_dia(db, dia)
    if not snapshot:
        # Sem foto de hoje (PCP fora do ar na 1ª abertura, ou integração
        # desligada): cai para a última foto disponível, sinalizando a data.
        try:
            ultimas = db.table("estoque_pcp_snapshot").select("data_ref")\
                .order("data_ref", desc=True).limit(1).execute().data
        except Exception:
            ultimas = []
        if not ultimas:
            return {"itens": [], "data_ref": None, "sincronizado_em": None,
                    "desatualizado": True, "sync": sync,
                    "integracao": pcp_estoque_service.integracao_ativa()}
        dia = date.fromisoformat(ultimas[0]["data_ref"])
        snapshot = _snapshot_do_dia(db, dia)

    sincronizado_em = snapshot[0].get("sincronizado_em") if snapshot else None
    comprometido_por_pid = _comprometido_por_produto(db, sincronizado_em)

    # Agrupa o comprometido por código (o snapshot é por código).
    cod_por_pid = _codigo_por_produto_id(db)
    comprometido_por_codigo: dict = {}
    for pid, qtd in comprometido_por_pid.items():
        cod = cod_por_pid.get(pid)
        if cod:
            comprometido_por_codigo[cod] = comprometido_por_codigo.get(cod, 0.0) + qtd

    mes_atual = _hoje_brt().strftime("%Y-%m")
    vendido_mes = _vendido_no_mes_por_codigo(db, mes_atual)
    ultimo_fechado = _ultimo_mes_fechado([row.get("sales_history") for row in snapshot])
    linha_por_codigo = linha_produto.mapa_por_codigo(db)

    itens = []
    for row in snapshot:
        cod = (row.get("codigo") or "").strip().upper()
        pa = float(row.get("estoque_pa") or 0)
        sa = float(row.get("estoque_sa") or 0)
        comp = comprometido_por_codigo.get(cod, 0.0)
        # Pode ficar negativo: a foto é de manhã e mais OVs entraram do que havia
        # material. Mostrar negativo é o sinal, não um erro para esconder.
        disponivel = pa - comp
        consumo = float(row.get("consumo_medio") or 0)
        cobertura_pcp = row.get("cobertura_meses")
        cobertura_pcp = float(cobertura_pcp) if cobertura_pcp is not None else None
        # Cobertura do disponível (PA+SA já comprometidos descontados), que é a
        # que responde "por quanto tempo ainda dá conta".
        cob_disp = round((disponivel + sa) / consumo, 1) if consumo > 0 else None
        historico = row.get("sales_history") or {}
        media_3m, media_3m_ant, tendencia_pct = _tendencia_do_historico(historico, ultimo_fechado)
        itens.append({
            "codigo": row.get("codigo"),
            "descricao": row.get("descricao"),
            "familia": row.get("familia"),
            "linha": _linha_do_item(row.get("codigo"), row.get("familia"), linha_por_codigo),
            "estoque_pcp": round(pa),
            "estoque_sa": round(sa),
            "comprometido": round(comp),
            "disponivel": round(disponivel),
            "consumo_medio": round(consumo, 1),
            "cobertura_pcp": cobertura_pcp,
            "cobertura_disponivel": cob_disp,
            "status": _status_cobertura(cob_disp, consumo),
            "vendido_mes_atual": round(vendido_mes.get(cod, 0.0)),
            "tendencia_pct": tendencia_pct,
            "media_3m": media_3m,
            "media_3m_anterior": media_3m_ant,
        })

    itens.sort(key=lambda i: (i["cobertura_disponivel"] is None, i["cobertura_disponivel"] or 0))
    resultado = {
        "itens": itens,
        "data_ref": dia.isoformat(),
        "sincronizado_em": sincronizado_em,
        "desatualizado": dia != _hoje_brt(),
        "mes_atual": mes_atual,
        "ultimo_mes_fechado": ultimo_fechado,
        "sync": sync,
        "integracao": pcp_estoque_service.integracao_ativa(),
    }
    # Guarda para as telas de exibição. Vale também o resultado vindo de uma
    # chamada com sincronização: ele é mais fresco ainda.
    _CACHE_EXIBICAO["dados"] = {**resultado, "sync": None}
    _CACHE_EXIBICAO["em"] = time.monotonic()
    return resultado
