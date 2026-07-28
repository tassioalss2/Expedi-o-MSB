"""Integração com o app de cobertura de estoque do PCP (projeto Supabase próprio).

Lê a view `pa_coverage`, combinada com o PCP: eles calculam a cobertura do lado
deles (mesma fórmula que a gente tinha deduzido e conferido — confirmada por
eles) e expõem já pronta, em vez da gente reimplementar a conta aqui. Se um dia
mudarem a fórmula, avisam antes — combinado com eles.

Aqui a gente só LÊ, com uma chave de leitura dedicada (`ace-msb-integracao`);
nada é escrito no banco deles.

Cruzamento pelo CÓDIGO do produto, que é o mesmo dos dois lados
(`produtos.codigo` aqui, `pa_coverage.code` lá) — não precisa de tabela de
mapeamento.

Colunas da view (conforme combinado com o PCP):
    code, description, family      identificação do item
    stock, stock_sa                estoque PA e SA separados
    stock_total                    PA + SA
    avg_consumption                média de venda dos últimos 6 meses
    coverage_months                stock_total ÷ avg_consumption; null = sem
                                    venda nos últimos 6 meses

Configuração (Render → Environment, ou .env local). Sem as duas variáveis a
integração fica desligada e o app segue funcionando como antes:
    PCP_SUPABASE_URL
    PCP_SUPABASE_KEY

Ambas precisam estar declaradas em app/core/config.py: o Settings recusa
variável extra, então configurar no ambiente sem declarar lá derruba o boot.
"""
from datetime import datetime, timezone

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


def _status(cobertura, consumo_medio: float) -> str:
    if consumo_medio <= 0 or cobertura is None:
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


def _montar(row: dict) -> dict:
    consumo_medio = round(float(row.get("avg_consumption") or 0), 2)
    cobertura = row.get("coverage_months")
    cobertura = round(float(cobertura), 1) if cobertura is not None else None
    return {
        "codigo": row.get("code"),
        "descricao": row.get("description"),
        "familia": row.get("family"),
        # PA e SA separados: a expedição só pode contar com o PA hoje; o SA ainda
        # precisa passar pela produção. A cobertura (do PCP) usa os dois.
        "estoque": round(float(row.get("stock") or 0)),
        "estoque_sa": round(float(row.get("stock_sa") or 0)),
        "estoque_total": round(float(row.get("stock_total") or 0)),
        "consumo_medio": consumo_medio,
        "cobertura_meses": cobertura,
        "status": _status(cobertura, consumo_medio),
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
            f"{url}/rest/v1/pa_coverage",
            params={"select": "code,description,family,stock,stock_sa,stock_total,avg_consumption,coverage_months"},
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        linhas = resp.json()
    except Exception:
        # Mantém o último cache válido, se houver — melhor dado de 1h atrás que nada.
        return dados or {}

    mapa = {}
    for row in linhas:
        codigo = (row.get("code") or "").strip()
        if codigo:
            mapa[codigo.upper()] = _montar(row)
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
