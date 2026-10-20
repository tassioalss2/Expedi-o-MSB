"""Estados e municípios do Brasil — padroniza o "Local de Entrega" (antes texto
livre, cada operador escrevia de um jeito). Municípios vêm da API pública do
IBGE, cacheados em memória por UF (a lista de cidades de um estado não muda) —
buscar por UF é rápido (~200 cidades) e evita ambiguidade de cidades com o
mesmo nome em estados diferentes."""
import json
from pathlib import Path

import requests

_UFS = [
    ("AC", "Acre"), ("AL", "Alagoas"), ("AP", "Amapá"), ("AM", "Amazonas"),
    ("BA", "Bahia"), ("CE", "Ceará"), ("DF", "Distrito Federal"), ("ES", "Espírito Santo"),
    ("GO", "Goiás"), ("MA", "Maranhão"), ("MT", "Mato Grosso"), ("MS", "Mato Grosso do Sul"),
    ("MG", "Minas Gerais"), ("PA", "Pará"), ("PB", "Paraíba"), ("PR", "Paraná"),
    ("PE", "Pernambuco"), ("PI", "Piauí"), ("RJ", "Rio de Janeiro"), ("RN", "Rio Grande do Norte"),
    ("RS", "Rio Grande do Sul"), ("RO", "Rondônia"), ("RR", "Roraima"), ("SC", "Santa Catarina"),
    ("SP", "São Paulo"), ("SE", "Sergipe"), ("TO", "Tocantins"),
]
_UFS_VALIDAS = {uf for uf, _ in _UFS}
_cache_municipios: dict[str, list[str]] = {}
_ARQUIVO: list = [None]


def listar_estados() -> list:
    return [{"uf": uf, "nome": nome} for uf, nome in sorted(_UFS, key=lambda x: x[1])]


def _do_arquivo() -> dict:
    """A lista oficial, gravada no repositório (5.571 municípios, 95 KB).

    Antes isto vinha do IBGE a cada primeira consulta de uma UF. Cadastrar uma
    OV passava a depender de um serviço externo responder, e quando ele não
    respondia o campo de cidade ficava mudo — sem lista e sem explicação, como
    aconteceu no cadastro de 15/10/2026. A relação de municípios do Brasil muda
    uma vez por década; ela merece viver aqui dentro.
    """
    if _ARQUIVO[0] is None:
        try:
            caminho = Path(__file__).resolve().parent.parent / "data" / "municipios_por_uf.json"
            _ARQUIVO[0] = json.loads(caminho.read_text(encoding="utf-8"))
        except Exception as exc:
            print("lista local de municipios indisponivel: %s" % str(exc)[:120])
            _ARQUIVO[0] = {}
    return _ARQUIVO[0]


_PAISES: list = [None]


def listar_paises() -> list:
    """Os 193 paises da ONU, em portugues, com a sigla ISO-2 que vai no
    documento de exportacao. Lista do IBGE, gravada no repositorio pelo mesmo
    motivo dos municipios: cadastro de OV nao pode depender de API externa."""
    if _PAISES[0] is None:
        try:
            caminho = Path(__file__).resolve().parent.parent / "data" / "paises.json"
            _PAISES[0] = json.loads(caminho.read_text(encoding="utf-8"))
        except Exception as exc:
            print("lista de paises indisponivel: %s" % str(exc)[:120])
            _PAISES[0] = []
    return _PAISES[0]


def listar_municipios(uf: str) -> list:
    uf = (uf or "").strip().upper()
    if uf not in _UFS_VALIDAS:
        return []
    if uf in _cache_municipios:
        return _cache_municipios[uf]

    nomes = list(_do_arquivo().get(uf) or [])
    if not nomes:
        # Só se o arquivo faltar (deploy incompleto): tenta o IBGE como antes.
        try:
            resp = requests.get(
                f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios",
                timeout=6,
            )
            resp.raise_for_status()
            nomes = sorted({m["nome"] for m in resp.json()})
        except Exception as exc:
            print("IBGE indisponivel para %s: %s" % (uf, str(exc)[:120]))
            nomes = []
    if nomes:
        _cache_municipios[uf] = nomes
    return nomes
