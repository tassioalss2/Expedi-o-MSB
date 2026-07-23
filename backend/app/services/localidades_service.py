"""Estados e municípios do Brasil — padroniza o "Local de Entrega" (antes texto
livre, cada operador escrevia de um jeito). Municípios vêm da API pública do
IBGE, cacheados em memória por UF (a lista de cidades de um estado não muda)."""
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


def listar_estados() -> list:
    return [{"uf": uf, "nome": nome} for uf, nome in sorted(_UFS, key=lambda x: x[1])]


def listar_municipios(uf: str) -> list:
    uf = (uf or "").strip().upper()
    if uf not in _UFS_VALIDAS:
        return []
    if uf in _cache_municipios:
        return _cache_municipios[uf]
    try:
        resp = requests.get(
            f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios",
            timeout=6,
        )
        resp.raise_for_status()
        nomes = sorted({m["nome"] for m in resp.json()})
    except Exception:
        nomes = []
    if nomes:
        _cache_municipios[uf] = nomes
    return nomes
