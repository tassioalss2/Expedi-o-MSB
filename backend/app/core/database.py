"""
Cliente HTTP direto para o Supabase REST API (PostgREST).
Substitui o SDK supabase que tem incompatibilidades com Python 3.14.
"""
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional
import requests
from app.core.config import settings


# Uma sessão HTTP por thread, em vez de uma conexão nova por consulta.
#
# `requests.get(...)` solto abre TCP + TLS toda vez. Contra o Supabase isso
# custava 564 ms por consulta, e o app conversa com o banco dezenas de vezes
# por tela: o painel financeiro fazia ~40 chamadas, quase todas pagando o
# aperto de mão de novo. Reusando a conexão a mesma consulta leva 184 ms — três
# vezes mais rápido, em TUDO, sem mudar uma linha de lógica.
#
# Por thread e não global: o FastAPI roda endpoint síncrono num pool de
# threads, e `Session` não promete ser segura para uso concorrente. Uma por
# thread reusa a conexão do mesmo jeito e não divide estado com ninguém.
_local = threading.local()

# Pool FIXO, criado uma vez. Um `ThreadPoolExecutor` novo a cada leitura cria
# threads novas, e thread nova não tem sessão: cada página voltava a pagar o
# aperto de mão TLS que a sessão existe para evitar — o paralelo ficava mais
# lento que a sequência. Com o pool fixo, as mesmas threads voltam e trazem a
# conexão delas quente.
_POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="leitura")


def _sessao() -> requests.Session:
    s = getattr(_local, "sessao", None)
    if s is None:
        s = requests.Session()
        # O pool acompanha o lote: as leituras vêm em sequência na mesma
        # thread, mas o keep-alive do PostgREST derruba conexão ociosa e o
        # adaptador precisa ter de onde tirar outra sem recomeçar tudo.
        adaptador = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=8)
        s.mount("https://", adaptador)
        s.mount("http://", adaptador)
        _local.sessao = s
    return s


def ler_tudo(pagina, tamanho: int = 1000, janela: int = 6, teto: int = 200) -> list:
    """Lê uma tabela inteira, buscando um punhado de páginas ao mesmo tempo.

    `pagina(limite, deslocamento) -> list` é o que varia; o resto é sempre
    igual e estava copiado em cada serviço, sempre em sequência.

    Por que paralelo: o PostgREST corta em 1.000 linhas por página e não há
    como pedir mais. As 5.074 movimentações viram 6 páginas, e cada ida à rede
    custa ~170 ms de latência pura — o banco em si é instantâneo nessas
    tabelas, então o tempo é só espera. Em sequência dá 3,48 s; buscando as
    páginas juntas, 1,25 s, com exatamente as mesmas linhas.
    (Índice não resolveria nada disso: buscar UMA linha com filtro custa os
    mesmos 167 ms que buscar uma linha sem filtro nenhum.)

    Cada thread tem a sua sessão HTTP — ver `_sessao` —, então as páginas não
    disputam conexão.

    A primeira página vem sozinha: na maioria das tabelas ela já é a última, e
    aí não se abre thread nenhuma.
    """
    primeira = pagina(tamanho, 0)
    if len(primeira) < tamanho:
        return primeira

    linhas = list(primeira)
    offset = tamanho
    while offset < teto * tamanho:
        offsets = [offset + i * tamanho for i in range(janela)]
        lotes = list(_POOL.map(lambda o: pagina(tamanho, o), offsets))
        for lote in lotes:
            linhas += lote
        # Página curta em qualquer posição significa que o fim chegou dentro
        # desta janela — o que veio depois dela já está vazio.
        if any(len(l) < tamanho for l in lotes):
            break
        offset += janela * tamanho
    return linhas


class QueryBuilder:
    """Builder de queries para o PostgREST do Supabase."""

    def __init__(self, base_url: str, headers: dict, table: str):
        self._base_url = base_url
        self._headers = headers
        self._table = table
        self._filters: list[str] = []
        self._select_cols = "*"
        self._order_col: Optional[str] = None
        self._order_desc = False
        self._limit_val: Optional[int] = None
        self._offset_val: Optional[int] = None
        self._single = False

    def select(self, cols: str = "*"):
        self._select_cols = cols
        return self

    def eq(self, col: str, val: Any):
        self._filters.append(f"{col}=eq.{val}")
        return self

    def ilike(self, col: str, val: str):
        self._filters.append(f"{col}=ilike.{val}")
        return self

    def or_(self, condicoes: str):
        """`(cond or cond)` — no PostgREST é `or=(a,b)`.

        Quem chama monta as condições no formato `coluna.operador.valor`,
        separadas por vírgula. Dentro do `or()` o coringa do ilike é `*`, não `%`:
        `%` cru na URL é sequência de escape inválida.
        """
        self._filters.append(f"or=({condicoes})")
        return self

    def neq(self, col: str, val: Any):
        self._filters.append(f"{col}=neq.{val}")
        return self

    def gte(self, col: str, val: Any):
        self._filters.append(f"{col}=gte.{val}")
        return self

    def lte(self, col: str, val: Any):
        self._filters.append(f"{col}=lte.{val}")
        return self

    def not_(self):
        return self

    def is_(self, col: str, val: Any):
        """`col is <val>` — para null e booleano, onde o PostgREST exige `is.`
        em vez de `eq.` (`eq.null` compara com a string "null").

        Faltava, e a chamada em `crm_service.ganhas_sem_ov` estourava
        AttributeError dentro de um `except Exception` que devolvia lista vazia:
        a fila do repasse ficava permanentemente vazia sem erro na tela.
        """
        self._filters.append(f"{col}=is.{val}")
        return self

    def not_is(self, col: str, val: Any):
        """`col is not <val>`. Nome separado porque `not_()` aqui é no-op e
        encadear `.not_.is_(...)` não funciona neste builder."""
        self._filters.append(f"{col}=not.is.{val}")
        return self

    def in_(self, col: str, vals: list):
        joined = ",".join(str(v) for v in vals)
        self._filters.append(f"{col}=in.({joined})")
        return self

    def order(self, col: str, desc: bool = False):
        self._order_col = col
        self._order_desc = desc
        return self

    def limit(self, n: int):
        self._limit_val = n
        return self

    def offset(self, n: int):
        """Paginação. O PostgREST tem um teto de linhas por resposta (1000 por
        padrão no Supabase) que o `limit` NÃO ultrapassa — pedir 20000 devolve
        1000 sem erro nenhum. Ler tabela grande sem paginar trunca em silêncio,
        então quem precisa do conjunto todo usa offset em laço."""
        self._offset_val = n
        return self

    def single(self):
        self._single = True
        return self

    def _build_url(self) -> str:
        url = f"{self._base_url}/{self._table}?select={self._select_cols}"
        for f in self._filters:
            url += f"&{f}"
        if self._order_col:
            direction = "desc" if self._order_desc else "asc"
            url += f"&order={self._order_col}.{direction}"
        if self._limit_val:
            url += f"&limit={self._limit_val}"
        if getattr(self, "_offset_val", None):
            url += f"&offset={self._offset_val}"
        return url

    def execute(self):
        headers = dict(self._headers)
        if self._single:
            headers["Accept"] = "application/vnd.pgrst.object+json"
        resp = _sessao().get(self._build_url(), headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return type("Result", (), {"data": data})()


class Table:
    def __init__(self, base_url: str, headers: dict, table: str):
        self._base_url = base_url
        self._headers = headers
        self._table = table

    def select(self, cols: str = "*") -> QueryBuilder:
        qb = QueryBuilder(self._base_url, self._headers, self._table)
        qb.select(cols)
        return qb

    def insert(self, data: dict | list) -> "MutationBuilder":
        return MutationBuilder(self._base_url, self._headers, self._table, "POST", data)

    def update(self, data: dict) -> "MutationBuilder":
        return MutationBuilder(self._base_url, self._headers, self._table, "PATCH", data)

    def delete(self) -> "MutationBuilder":
        return MutationBuilder(self._base_url, self._headers, self._table, "DELETE", None)

    def upsert(self, data: Any, on_conflict: Optional[str] = None) -> "MutationBuilder":
        """`on_conflict` nomeia a coluna única que decide o que é a mesma linha.

        Sem ele o PostgREST resolve pela chave primária — e numa tabela cujo id
        é gerado no banco isso nunca casa, então o upsert vira insert e esbarra
        no índice único. É o caso do espelho do D365, que se reconhece por
        `identidade`, não por `id`.
        """
        return MutationBuilder(self._base_url, self._headers, self._table, "POST", data,
                               upsert=True, on_conflict=on_conflict)


class MutationBuilder:
    def __init__(self, base_url: str, headers: dict, table: str,
                 method: str, data: Any, upsert: bool = False,
                 on_conflict: Optional[str] = None):
        self._base_url = base_url
        self._headers = headers
        self._table = table
        self._method = method
        self._data = data
        self._upsert = upsert
        self._on_conflict = on_conflict
        self._filters: list[str] = []

    def eq(self, col: str, val: Any):
        self._filters.append(f"{col}=eq.{val}")
        return self

    def in_(self, col: str, vals: list):
        """Mesma forma do filtro de leitura — apagar/atualizar um lote de uma vez.

        Sem isto, regravar 61 notas custava 61 chamadas; o espelho do D365 apaga
        o lote inteiro antes de reinserir.
        """
        joined = ",".join(str(v) for v in vals)
        self._filters.append(f"{col}=in.({joined})")
        return self

    def execute(self):
        url = f"{self._base_url}/{self._table}"
        partes = list(self._filters)
        if self._on_conflict:
            partes.append(f"on_conflict={self._on_conflict}")
        if partes:
            url += "?" + "&".join(partes)

        headers = {**self._headers, "Prefer": "return=representation"}
        if self._upsert:
            headers["Prefer"] = "return=representation,resolution=merge-duplicates"

        if self._method == "POST":
            resp = _sessao().post(url, headers=headers, json=self._data)
        elif self._method == "PATCH":
            resp = _sessao().patch(url, headers=headers, json=self._data)
        elif self._method == "DELETE":
            resp = _sessao().delete(url, headers=headers)
        else:
            resp = _sessao().post(url, headers=headers, json=self._data)

        if resp.status_code >= 400:
            # O corpo do PostgREST diz QUAL coluna, QUAL constraint e por quê;
            # `raise_for_status` sozinho devolve só "400 Bad Request" e manda
            # todo mundo adivinhar. Numa gravação que falha pela metade, essa
            # frase é a diferença entre consertar e ficar olhando.
            raise requests.HTTPError(
                "%s %s em %s — %s" % (resp.status_code, resp.reason,
                                      f"{self._method} {self._table}", resp.text[:500]),
                response=resp)
        data = resp.json() if resp.text else []
        if not isinstance(data, list):
            data = [data]
        return type("Result", (), {"data": data})()


class SupabaseClient:
    def __init__(self, url: str, key: str):
        self._base_url = f"{url}/rest/v1"
        self._headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def table(self, name: str) -> Table:
        return Table(self._base_url, self._headers, name)


_client: Optional[SupabaseClient] = None
_service_client: Optional[SupabaseClient] = None


def get_db() -> SupabaseClient:
    global _client
    if _client is None:
        _client = SupabaseClient(settings.supabase_url, settings.supabase_key)
    return _client


def get_service_db() -> SupabaseClient:
    """Usa a service role key que ignora RLS — para operações do servidor."""
    global _service_client
    if _service_client is None:
        _service_client = SupabaseClient(settings.supabase_url, settings.supabase_service_key)
    return _service_client
