# -*- coding: utf-8 -*-
"""O frete que a BRIX vai cobrar nesta carga, pela tabela contratada.

Tabela convencional de outubro/2026, origem Lauro de Freitas/BA. A conta é a
mesma para todo destino:

    peso taxado  = maior entre o peso real e o peso cubado (m³ × fator)
    frete-peso   = maior(peso taxado, peso mínimo do destino) × tarifa por kg
    ad valorem   = 0,33% do valor da NF
    GRIS         = 0,05% do valor da NF (0,02% em São Paulo)

O "peso mínimo" da tabela é a tarifa mínima dividida pela tarifa por kg — por
isso a fórmula acima já devolve R$ 110,88 em qualquer carga leve, sem precisar
de um caso especial.

O que esta conta NÃO cobre, e por isso o resultado é ESTIMATIVA: pedágio, ICMS,
taxa de interior (redespacho) e qualquer acordo fora da tabela. Cubagem fora do
padrão continua sendo cotada com eles antes do faturamento.
"""
import json
import unicodedata
from pathlib import Path
from typing import Optional

_TABELA: list = [None]


def _sem_acento(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", str(t or ""))
                   if not unicodedata.combining(c)).strip().upper()


def tabela() -> dict:
    if _TABELA[0] is None:
        try:
            caminho = Path(__file__).resolve().parent.parent / "data" / "tabela_frete_brix.json"
            _TABELA[0] = json.loads(caminho.read_text(encoding="utf-8"))
        except Exception as exc:
            print("tabela de frete indisponivel: %s" % str(exc)[:140])
            _TABELA[0] = {"destinos": []}
    return _TABELA[0]


def _achar_destino(cidade: Optional[str], uf: Optional[str]) -> tuple:
    """(destino, como_achou). Cidade exata primeiro; depois a capital da UF.

    Quando a cidade não está na tabela, a carga vai por REDESPACHO: a BRIX leva
    até a capital e outra transportadora faz o trecho final, que é cobrado à
    parte. Devolver a linha da capital serve de piso — e o chamador precisa
    dizer que falta o trecho, senão a estimativa vira promessa.
    """
    t = tabela()
    alvo_cidade, alvo_uf = _sem_acento(cidade), _sem_acento(uf)
    if alvo_cidade:
        for d in t.get("destinos", []):
            if _sem_acento(d["cidade"]) == alvo_cidade and (
                    not alvo_uf or d["uf"] == alvo_uf):
                return d, "cidade"
    if alvo_uf:
        for d in t.get("destinos", []):
            if d["uf"] == alvo_uf:
                return d, "capital_da_uf"
    return None, "nao_encontrado"


def estimar(uf: Optional[str], cidade: Optional[str] = None,
            peso_kg: float = 0, m3: float = 0, valor_nf: float = 0) -> dict:
    """Quanto esta carga custa pela tabela, com a conta aberta."""
    t = tabela()
    destino, como = _achar_destino(cidade, uf)
    fator = float(t.get("fator_cubagem_kg_m3") or 300)
    peso_cubado = round(float(m3 or 0) * fator, 2)
    peso_taxado = max(float(peso_kg or 0), peso_cubado)

    if not destino:
        return {
            "encontrado": False,
            "motivo": "Destino fora da tabela da BRIX — precisa de cotação.",
            "peso_real_kg": round(float(peso_kg or 0), 2),
            "peso_cubado_kg": peso_cubado,
            "peso_taxado_kg": round(peso_taxado, 2),
        }

    peso_cobrado = max(peso_taxado, float(destino["peso_minimo_kg"]))
    # A tarifa mínima é um valor declarado (R$ 110,88), não o produto do peso
    # mínimo pela tarifa: em Brasília, 36,35 × 3,05 dá 110,8675 e a carga leve
    # saía um centavo abaixo do que a transportadora cobra. Quem manda é o
    # maior dos dois.
    frete_peso = max(peso_cobrado * float(destino["tarifa_kg"]),
                     float(t.get("tarifa_minima") or 0))
    ad_valorem = float(valor_nf or 0) * float(t.get("ad_valorem_pct") or 0) / 100
    gris_pct = float(destino.get("gris_pct", t.get("gris_pct_padrao") or 0))
    gris = float(valor_nf or 0) * gris_pct / 100
    total = frete_peso + ad_valorem + gris

    return {
        "encontrado": True,
        "transportadora": t.get("transportadora"),
        "vigencia": t.get("vigencia"),
        "destino": "%s/%s" % (destino["cidade"], destino["uf"]),
        "por_capital": como == "capital_da_uf",
        # Redespacho tem custo próprio que a tabela não traz: dizer isso é o que
        # separa estimativa de promessa.
        "aviso": ("Cidade fora da tabela: valor calculado pela capital %s/%s. "
                  "O trecho de redespacho até o destino é cobrado à parte."
                  % (destino["cidade"], destino["uf"])) if como == "capital_da_uf" else None,
        "peso_real_kg": round(float(peso_kg or 0), 2),
        "peso_cubado_kg": peso_cubado,
        "peso_taxado_kg": round(peso_taxado, 2),
        "peso_cobrado_kg": round(peso_cobrado, 2),
        "usou_peso_minimo": peso_cobrado > peso_taxado + 0.001,
        "fator_cubagem": fator,
        "tarifa_kg": float(destino["tarifa_kg"]),
        "frete_peso": round(frete_peso, 2),
        "ad_valorem": round(ad_valorem, 2),
        "ad_valorem_pct": float(t.get("ad_valorem_pct") or 0),
        "gris": round(gris, 2),
        "gris_pct": gris_pct,
        "total": round(total, 2),
        "prazo_capital": destino.get("prazo_capital"),
        "prazo_redespacho": destino.get("prazo_redespacho"),
        "premissa_cubagem": t.get("observacao_fator"),
    }
