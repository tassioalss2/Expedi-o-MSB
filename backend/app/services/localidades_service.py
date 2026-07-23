"""Estados e municípios do Brasil — padroniza o "Local de Entrega" (antes texto
livre, cada operador escrevia de um jeito). Municípios vêm da API pública do
IBGE; a lista completa do país é buscada uma vez e cacheada em memória (não
muda em runtime)."""
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
_cache_pais: list[dict] | None = None  # [{"nome": ..., "uf": ...}, ...] — todo o Brasil


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


def _municipios_pais() -> list:
    global _cache_pais
    if _cache_pais is not None:
        return _cache_pais
    try:
        resp = requests.get("https://servicodados.ibge.gov.br/api/v1/localidades/municipios", timeout=10)
        resp.raise_for_status()
        dados = []
        for m in resp.json():
            try:
                uf = m["microrregiao"]["mesorregiao"]["UF"]["sigla"]
            except (KeyError, TypeError):
                continue
            dados.append({"nome": m["nome"], "uf": uf})
        dados.sort(key=lambda d: d["nome"])
        _cache_pais = dados
    except Exception:
        return []
    return _cache_pais


def buscar_municipios(termo: str, limite: int = 15) -> list:
    """Autocompletar por texto — o operador digita a cidade e o app recomenda,
    sem precisar escolher a UF antes."""
    q = (termo or "").strip().lower()
    if len(q) < 2:
        return []
    pais = _municipios_pais()
    comeca_com = [m for m in pais if m["nome"].lower().startswith(q)]
    contem = [m for m in pais if q in m["nome"].lower() and m not in comeca_com]
    return [f"{m['nome']}/{m['uf']}" for m in (comeca_com + contem)[:limite]]
