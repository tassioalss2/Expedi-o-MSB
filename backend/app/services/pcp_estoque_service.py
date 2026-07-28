"""Integração com o app de cobertura de estoque do PCP (projeto Supabase próprio).

O PCP mantém `pa_products` com estoque de produto acabado e o histórico de vendas
por mês. Aqui a gente só LÊ: nada é escrito no banco deles.

Cruzamento pelo CÓDIGO do produto, que é o mesmo dos dois lados
(`produtos.codigo` aqui, `pa_products.code` lá) — não precisa de tabela de mapeamento.

Fórmula da cobertura (derivada dos números que o app do PCP exibe e conferida
item a item contra a tela deles):

    consumo_medio   = Σ vendas dos 6 meses ANTERIORES ao corrente ÷ 6
    estoque_total   = stock (PA) + stock_sa (semi-acabado)
    cobertura_meses = estoque_total ÷ consumo_medio

O SA entra na conta: no VCET-5110CK1 a tela do PCP mostra 1,6 mês, que é
(701 PA + 547 SA) ÷ 796, não 701 ÷ 796 (daria 0,9 e mudaria o status de Atenção
para Crítico). Conferido também no 62038: (211 + 187) ÷ 796 = 0,5, igual à tela.

Se o PCP mudar a fórmula, os dois apps passam a mostrar números diferentes para o
mesmo item — pior que não ter integração. Por isso a confirmação da fórmula faz
parte do combinado com eles, e a origem fica sempre explícita na tela.

Configuração (Render → Environment, ou .env local). Sem as duas variáveis a
integração fica desligada e o app segue funcionando como antes:
    PCP_SUPABASE_URL
    PCP_SUPABASE_KEY

Ambas precisam estar declaradas em app/core/config.py: o Settings recusa
variável extra, então configurar no ambiente sem declarar lá derruba o boot.
"""
from datetime import date, datetime, timedelta, timezone

import requests

from app.core.config import settings

# O PCP atualiza o estoque uma vez ao dia; cache curto já evita repetir a chamada
# a cada card aberto no painel, sem deixar o dado velho.
_TTL_SEGUNDOS = 600
_cache: dict = {"em": None, "dados": None}

_TIMEOUT = 8

# Faixas de status, iguais às do app do PCP (em meses de cobertura).
_CRITICO, _ATENCAO, _ADEQUADO, _ALTO = 1.0, 2.0, 6.0, 12.0


def _config() -> tuple:
    url = (settings.pcp_supabase_url or "").strip().rstrip("/")
    key = (settings.pcp_supabase_key or "").strip()
    return (url, key) if (url and key) else (None, None)


def integracao_ativa() -> bool:
    return _config()[0] is not None


def _janela_6_meses(hoje: date) -> list:
    """As 6 competências anteriores à corrente, no formato 'AAAA-MM'."""
    comps, ref = [], date(hoje.year, hoje.month, 1)
    for _ in range(6):
        ref = date(ref.year, ref.month, 1) - timedelta(days=1)
        comps.append(f"{ref.year:04d}-{ref.month:02d}")
    return comps


def _status(cobertura, consumo_medio: float) -> str:
    if consumo_medio <= 0:
        return "SEM_GIRO"
    if cobertura is None:
        return "SEM_GIRO"
    if cobertura < _CRITICO:
        return "CRITICO"
    if cobertura < _ATENCAO:
        return "ATENCAO"
    if cobertura < _ADEQUADO:
        return "ADEQUADO"
    if cobertura < _ALTO:
        return "ALTO"
    return "EXCESSIVO"


def _montar(row: dict, janela: list) -> dict:
    historico = row.get("sales_history") or {}
    vendas = sum(float(historico.get(c) or 0) for c in janela)
    consumo_medio = round(vendas / 6, 2)
    estoque_pa = float(row.get("stock") or 0)
    estoque_sa = float(row.get("stock_sa") or 0)
    estoque_total = estoque_pa + estoque_sa
    cobertura = round(estoque_total / consumo_medio, 1) if consumo_medio > 0 else None
    return {
        "codigo": row.get("code"),
        "descricao": row.get("description"),
        "familia": row.get("family"),
        # PA e SA separados: a expedição só pode contar com o PA hoje; o SA ainda
        # precisa passar pela produção. A cobertura usa os dois (regra do PCP).
        "estoque": round(estoque_pa),
        "estoque_sa": round(estoque_sa),
        "estoque_total": round(estoque_total),
        "consumo_medio": consumo_medio,
        "cobertura_meses": cobertura,
        "status": _status(cobertura, consumo_medio),
        "atualizado_em": row.get("updated_at"),
    }


def _buscar_tudo() -> dict:
    """codigo -> dados de cobertura. Best-effort: qualquer falha devolve {} para a
    indisponibilidade do app do PCP nunca derrubar o painel de licitações."""
    agora = datetime.now(timezone.utc)
    em, dados = _cache["em"], _cache["dados"]
    if dados is not None and em and (agora - em).total_seconds() < _TTL_SEGUNDOS:
        return dados

    url, key = _config()
    if not url:
        return {}
    try:
        resp = requests.get(
            f"{url}/rest/v1/pa_products",
            params={"select": "code,description,family,stock,stock_sa,sales_history,updated_at"},
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        linhas = resp.json()
    except Exception:
        # Mantém o último cache válido, se houver — melhor dado de 1h atrás que nada.
        return dados or {}

    janela = _janela_6_meses(date.today())
    mapa = {}
    for row in linhas:
        codigo = (row.get("code") or "").strip()
        if codigo:
            mapa[codigo.upper()] = _montar(row, janela)
    _cache["em"], _cache["dados"] = agora, mapa
    return mapa


def cobertura_por_codigos(codigos: list) -> dict:
    """codigo -> cobertura, só para os códigos pedidos (os que o PCP não conhece
    ficam de fora)."""
    if not codigos:
        return {}
    tudo = _buscar_tudo()
    if not tudo:
        return {}
    out = {}
    for c in codigos:
        chave = str(c or "").strip().upper()
        if chave and chave in tudo:
            out[chave] = tudo[chave]
    return out


def cobertura_da_demanda(demanda: dict) -> dict:
    """Cobertura dos itens de uma demanda de licitação, para o card mostrar o
    estoque real em vez de depender de alguém perguntar ao PCP.

    Devolve {"itens": [...], "pior_status": ..., "integracao": bool}."""
    itens = demanda.get("itens") or []
    codigos = [it.get("codigo") for it in itens if it.get("codigo")]
    mapa = cobertura_por_codigos(codigos)
    if not mapa:
        return {"itens": [], "pior_status": None, "integracao": integracao_ativa()}

    ordem = ["SEM_GIRO", "EXCESSIVO", "ALTO", "ADEQUADO", "ATENCAO", "CRITICO"]
    saida, pior = [], None
    for it in itens:
        cod = str(it.get("codigo") or "").strip().upper()
        cob = mapa.get(cod)
        if not cob:
            continue
        qtd = float(it.get("qtd") or 0)
        estoque_pa = float(cob["estoque"])
        linha = {
            **cob,
            "qtd_demanda": round(qtd),
            # "Atende" olha só o PA: é o que a expedição pode faturar hoje. O SA
            # entra na cobertura mas ainda depende da produção, então não serve
            # para prometer entrega.
            "atende": estoque_pa >= qtd,
            "falta": round(max(0.0, qtd - estoque_pa)),
        }
        saida.append(linha)
        if pior is None or ordem.index(cob["status"]) > ordem.index(pior):
            pior = cob["status"]
    return {"itens": saida, "pior_status": pior, "integracao": True}
