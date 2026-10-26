# -*- coding: utf-8 -*-
"""Dias úteis da MSB — um calendário só, usado por todo mundo que conta dias.

Sábado, domingo e feriado não são dia sem notícia: ninguém trabalhou. O rastreio
dizia "sem notícia há 4 dias" numa segunda-feira sobre carga despachada na
quinta, e quem lia entendia abandono onde havia fim de semana (apontado pelo
Tássio em 26/10/2026).

A operação fica em Lauro de Freitas/BA, então contam os feriados nacionais, os
da Bahia e os do município. Os municipais estão em `data/feriados_msb.json`,
fora do código, porque mudam de ano para ano e quem sabe quais são é quem
trabalha lá.
"""
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Iterable, Optional

# Nacionais e estaduais. Carnaval, Sexta-feira Santa e Corpus Christi mudam de
# data todo ano — estão fixos aqui porque dependem da Páscoa, e uma conta de
# Páscoa no código seria mais difícil de conferir do que doze linhas.
_FIXOS = {
    # 2026
    "2026-01-01": "Confraternização Universal",
    "2026-02-16": "Carnaval (segunda)",
    "2026-02-17": "Carnaval",
    "2026-04-03": "Sexta-feira Santa",
    "2026-04-21": "Tiradentes",
    "2026-05-01": "Dia do Trabalho",
    "2026-06-04": "Corpus Christi",
    "2026-07-02": "Independência da Bahia",
    "2026-09-07": "Independência do Brasil",
    "2026-10-12": "Nossa Senhora Aparecida",
    "2026-11-02": "Finados",
    "2026-11-15": "Proclamação da República",
    "2026-11-20": "Consciência Negra",
    "2026-12-25": "Natal",
    # 2027
    "2027-01-01": "Confraternização Universal",
    "2027-02-08": "Carnaval (segunda)",
    "2027-02-09": "Carnaval",
    "2027-03-26": "Sexta-feira Santa",
    "2027-04-21": "Tiradentes",
    "2027-05-01": "Dia do Trabalho",
    "2027-05-27": "Corpus Christi",
    "2027-07-02": "Independência da Bahia",
    "2027-09-07": "Independência do Brasil",
    "2027-10-12": "Nossa Senhora Aparecida",
    "2027-11-02": "Finados",
    "2027-11-15": "Proclamação da República",
    "2027-11-20": "Consciência Negra",
    "2027-12-25": "Natal",
}

_CAMINHO = Path(__file__).resolve().parent.parent / "data" / "feriados_msb.json"
_CACHE: list = [None]


def feriados() -> dict:
    """{data ISO: motivo} — os fixos mais os municipais do arquivo."""
    if _CACHE[0] is None:
        extras = {}
        try:
            extras = json.loads(_CAMINHO.read_text(encoding="utf-8")).get("feriados") or {}
        except FileNotFoundError:
            pass
        except Exception as exc:
            print("feriados municipais ilegiveis: %s" % str(exc)[:140])
        _CACHE[0] = {**_FIXOS, **extras}
    return _CACHE[0]


def motivo(d: date) -> Optional[str]:
    """Por que este dia não é útil, quando não for."""
    if d.weekday() == 5:
        return "sábado"
    if d.weekday() == 6:
        return "domingo"
    return feriados().get(d.isoformat())


def eh_util(d: date) -> bool:
    return motivo(d) is None


def proximo_util(d: date) -> date:
    while not eh_util(d):
        d += timedelta(days=1)
    return d


def dias_uteis_entre(inicio: date, fim: date) -> int:
    """Dias úteis de `inicio` (exclusive) até `fim` (inclusive).

    É a contagem de "faz quantos dias": de sexta para segunda dá 1, não 3.
    Datas invertidas devolvem 0 — não existe esperar para trás.
    """
    if not inicio or not fim or fim <= inicio:
        return 0
    dias, d = 0, inicio + timedelta(days=1)
    while d <= fim:
        if eh_util(d):
            dias += 1
        d += timedelta(days=1)
    return dias


def somar_dias_uteis(inicio: date, quantidade: int) -> date:
    """A data que cai N dias úteis depois de `inicio`, sem contar o próprio dia."""
    d, restantes = inicio, max(int(quantidade or 0), 1)
    while restantes > 0:
        d += timedelta(days=1)
        if eh_util(d):
            restantes -= 1
    return d


def uteis_no_periodo(inicio: date, fim: date) -> Iterable[date]:
    d = inicio
    while d <= fim:
        if eh_util(d):
            yield d
        d += timedelta(days=1)
