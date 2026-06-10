"""
Cliente HTTP direto para o Supabase REST API (PostgREST).
Substitui o SDK supabase que tem incompatibilidades com Python 3.14.
"""
import json
from typing import Any, Optional
import requests
from app.core.config import settings


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
        return url

    def execute(self):
        headers = dict(self._headers)
        if self._single:
            headers["Accept"] = "application/vnd.pgrst.object+json"
        resp = requests.get(self._build_url(), headers=headers)
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

    def upsert(self, data: dict) -> "MutationBuilder":
        return MutationBuilder(self._base_url, self._headers, self._table, "POST", data, upsert=True)


class MutationBuilder:
    def __init__(self, base_url: str, headers: dict, table: str,
                 method: str, data: Any, upsert: bool = False):
        self._base_url = base_url
        self._headers = headers
        self._table = table
        self._method = method
        self._data = data
        self._upsert = upsert
        self._filters: list[str] = []

    def eq(self, col: str, val: Any):
        self._filters.append(f"{col}=eq.{val}")
        return self

    def execute(self):
        url = f"{self._base_url}/{self._table}"
        if self._filters:
            url += "?" + "&".join(self._filters)

        headers = {**self._headers, "Prefer": "return=representation"}
        if self._upsert:
            headers["Prefer"] = "return=representation,resolution=merge-duplicates"

        if self._method == "POST":
            resp = requests.post(url, headers=headers, json=self._data)
        elif self._method == "PATCH":
            resp = requests.patch(url, headers=headers, json=self._data)
        elif self._method == "DELETE":
            resp = requests.delete(url, headers=headers)
        else:
            resp = requests.post(url, headers=headers, json=self._data)

        resp.raise_for_status()
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
