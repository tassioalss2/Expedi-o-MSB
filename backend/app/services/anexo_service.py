# -*- coding: utf-8 -*-
"""Documentos anexados a uma OV.

A OV nasce de um papel — empenho, ordem de compra, autorizacao de fornecimento,
comprovante de pagamento, a carta com a exigencia de faturamento do orgao. Esse
papel ficava no e-mail de quem abriu a OV, e quem pegava o caso depois
(expedicao, faturamento, a pessoa que entrou no lugar de quem saiu) nao tinha
como ver o que o cliente tinha pedido.

O arquivo vive no bucket PRIVADO `anexos-ov` do Supabase Storage; a tabela
`pedido_anexos` guarda so o ponteiro. Download sempre por URL assinada de curta
duracao, gerada pelo backend — nenhum documento de cliente fica com link
publico.
"""
import os
import re
import unicodedata
import uuid
from typing import Optional

import requests
from fastapi import HTTPException

from app.core.config import settings
from app.core.database import get_service_db
from app.models.schemas import UsuarioOut

BUCKET = "anexos-ov"
TETO = 20 * 1024 * 1024          # 20 MB, igual ao teto do bucket
VALIDADE_LINK = 300              # 5 minutos: tempo de clicar e abrir, nao de circular

# Extensoes aceitas. Lista de permitidos, e nao de proibidos: o que entra aqui e
# documento de pedido, e qualquer coisa executavel so poderia ser engano ou
# coisa pior.
EXTENSOES = {
    ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".xlsx", ".xls", ".doc", ".docx",
    ".txt", ".csv", ".xml", ".zip",
}
TIPOS = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain", ".csv": "text/csv", ".xml": "application/xml",
    ".zip": "application/zip",
}


def _url():
    return settings.supabase_url.rstrip("/")


def _headers(extra: Optional[dict] = None) -> dict:
    k = settings.supabase_service_key
    h = {"Authorization": "Bearer %s" % k, "apikey": k}
    if extra:
        h.update(extra)
    return h


def _nome_seguro(nome: str) -> str:
    """O nome original vira rotulo; o caminho no bucket nasce limpo.

    Nome de arquivo de cliente vem com acento, espaco, parenteses e barra
    ("Empenho 2026NE004522 (2).pdf"). No caminho isso quebra o Storage ou cria
    pasta sem querer; na tela o nome original continua aparecendo inteiro.
    """
    base = os.path.basename(nome or "documento")
    base = unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode()
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._-")
    return (base or "documento")[:80]


def listar(pedido_id: str) -> list:
    db = get_service_db()
    try:
        linhas = db.table("pedido_anexos").select("*")\
            .eq("pedido_id", pedido_id).order("criado_em", desc=True).execute().data
    except Exception as exc:
        # Migration v54 ainda nao rodou: a OV abre normalmente, so sem anexos.
        print("pedido_anexos indisponivel: %s" % str(exc)[:120])
        return []
    ids = [l["criado_por"] for l in linhas if l.get("criado_por")]
    nomes = {}
    if ids:
        try:
            for u in db.table("usuarios").select("id, nome").in_("id", list(set(ids))).execute().data:
                nomes[u["id"]] = u.get("nome")
        except Exception:
            pass
    for l in linhas:
        l["criado_por_nome"] = nomes.get(l.get("criado_por"))
    return linhas


def anexar(pedido_id: str, conteudo: bytes, nome: str, usuario: UsuarioOut,
           descricao: Optional[str] = None, tipo: Optional[str] = None) -> dict:
    db = get_service_db()
    ped = db.table("pedidos").select("id, numero_pedido").eq("id", pedido_id).execute().data
    if not ped:
        raise HTTPException(404, "OV não encontrada")
    if not conteudo:
        raise HTTPException(422, "arquivo vazio")
    if len(conteudo) > TETO:
        raise HTTPException(413, "arquivo acima de 20 MB — comprima ou mande em partes")

    limpo = _nome_seguro(nome)
    ext = os.path.splitext(limpo)[1].lower()
    if ext not in EXTENSOES:
        raise HTTPException(
            422, "tipo de arquivo não aceito (%s). Aceitos: %s"
                 % (ext or "sem extensão", ", ".join(sorted(EXTENSOES))))

    # Um prefixo por OV, e um id no nome: dois arquivos com o mesmo nome no mesmo
    # pedido ("empenho.pdf" duas vezes) nao se sobrescrevem em silencio.
    caminho = "%s/%s-%s" % (pedido_id, uuid.uuid4().hex[:8], limpo)
    r = requests.post(
        "%s/storage/v1/object/%s/%s" % (_url(), BUCKET, caminho),
        headers=_headers({"Content-Type": tipo or TIPOS.get(ext, "application/octet-stream")}),
        data=conteudo, timeout=120)
    if r.status_code >= 300:
        raise HTTPException(502, "não consegui guardar o arquivo: %s" % r.text[:200])

    linha = {
        "pedido_id": pedido_id,
        "nome": os.path.basename(nome or limpo)[:200],
        "caminho": caminho,
        "tipo": tipo or TIPOS.get(ext),
        "tamanho": len(conteudo),
        "descricao": (descricao or "").strip() or None,
        "criado_por": str(usuario.id),
    }
    try:
        novo = db.table("pedido_anexos").insert(linha).execute().data[0]
    except Exception as exc:
        # Sem o registro o arquivo seria invisivel; nao deixa lixo no bucket.
        requests.delete("%s/storage/v1/object/%s/%s" % (_url(), BUCKET, caminho),
                        headers=_headers(), timeout=30)
        raise HTTPException(
            500, "não consegui registrar o anexo (a migration v54 já rodou?): %s"
                 % str(exc)[:160])
    novo["criado_por_nome"] = getattr(usuario, "nome", None)
    return novo


def link(anexo_id: str) -> dict:
    """URL assinada de 5 minutos. O bucket é privado e continua privado."""
    db = get_service_db()
    linhas = db.table("pedido_anexos").select("*").eq("id", anexo_id).execute().data
    if not linhas:
        raise HTTPException(404, "anexo não encontrado")
    a = linhas[0]
    r = requests.post(
        "%s/storage/v1/object/sign/%s/%s" % (_url(), BUCKET, a["caminho"]),
        headers=_headers({"Content-Type": "application/json"}),
        json={"expiresIn": VALIDADE_LINK}, timeout=30)
    if r.status_code >= 300:
        raise HTTPException(502, "não consegui gerar o link: %s" % r.text[:200])
    assinado = (r.json() or {}).get("signedURL") or ""
    return {"url": "%s/storage/v1%s" % (_url(), assinado if assinado.startswith("/") else "/" + assinado),
            "nome": a.get("nome"), "tipo": a.get("tipo")}


def remover(anexo_id: str, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    linhas = db.table("pedido_anexos").select("*").eq("id", anexo_id).execute().data
    if not linhas:
        raise HTTPException(404, "anexo não encontrado")
    a = linhas[0]
    try:
        requests.delete("%s/storage/v1/object/%s/%s" % (_url(), BUCKET, a["caminho"]),
                        headers=_headers(), timeout=30)
    except Exception as exc:
        # O registro sai de qualquer jeito: anexo que a pessoa mandou apagar e
        # continua na tela e pior do que um arquivo orfao no bucket.
        print("arquivo nao removido do bucket: %s" % str(exc)[:120])
    db.table("pedido_anexos").delete().eq("id", anexo_id).execute()
    return {"ok": True, "nome": a.get("nome")}
