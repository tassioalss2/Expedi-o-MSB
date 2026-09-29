# -*- coding: utf-8 -*-
"""Controle de devoluções — os pedidos que chegam por e-mail.

Hoje eles vivem só na conversa do Outlook: quem não estava no e-mail não sabe
que existem, e ninguém consegue dizer quantos estão abertos nem há quanto tempo.
Esta é a mesma ideia da caixa de entrada da licitação, aplicada a outro fluxo —
o motor traz o caso, a pessoa completa e resolve.

Duas decisões que vêm da medição nos e-mails reais (150 dias, 23 e-mails):

  A unidade é a CONVERSA, não o e-mail. Aqueles 23 e-mails são 10 casos; uma
  tratativa de devolução tem 5 idas e vindas. Guardar por e-mail faria a mesma
  devolução virar 5 cards.

  O que o motor extrai é PARCIAL: NF em 5 dos 10 casos, cliente em 3. Então
  campo vazio fica vazio e a tela pede que se complete. Inventar um número de NF
  aqui seria pior do que não ter nenhum.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import UsuarioOut

# O caminho de uma devolução, do que chega ao que fecha. Nomes do que a pessoa
# faz, não de estados abstratos.
STATUS = {
    "NOVA": "Nova",
    "EM_ANALISE": "Em análise",
    "AGUARDANDO_CLIENTE": "Aguardando o cliente",
    "AGUARDANDO_FISCAL": "Aguardando o fiscal",
    "NF_EMITIDA": "NF de devolução emitida",
    "CONCLUIDA": "Concluída",
    "CANCELADA": "Cancelada",
}
FINAIS = ("CONCLUIDA", "CANCELADA")


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _passo(usuario: Optional[UsuarioOut], texto: str) -> dict:
    return {
        "quando": _agora(),
        "quem": (usuario.nome if usuario else None) or "motor",
        "o_que": texto,
    }


def _limpa(v):
    return (str(v or "").strip() or None)


def registrar_do_email(dados: dict) -> dict:
    """O motor entrega uma conversa; aqui ela vira (ou atualiza) um caso.

    Idempotente pela `conversa_id`: o motor roda duas vezes por dia e não pode
    recriar o que já existe. Numa conversa que cresceu, só o que o e-mail sabe
    é atualizado — status, motivo e observação são da PESSOA e nunca são
    sobrescritos por uma releitura.
    """
    db = get_service_db()
    conversa = _limpa(dados.get("conversa_id"))
    if not conversa:
        raise HTTPException(422, "conversa_id é obrigatório para o caso vindo de e-mail.")

    # Busca INCLUSIVE os removidos: um e-mail que a pessoa tirou da lista ("isso
    # não é devolução") não pode voltar na rodada seguinte. Filtrar por `ativo`
    # aqui faria o motor recriá-lo duas vezes por dia, para sempre.
    todos = db.table("devolucoes").select("*").eq("conversa_id", conversa).execute().data
    removido = [x for x in todos if not x.get("ativo")]
    if removido and not [x for x in todos if x.get("ativo")]:
        return {"acao": "ignorado", "id": removido[0]["id"],
                "motivo": "conversa removida da lista por alguém"}
    achado = [x for x in todos if x.get("ativo")]
    campos = {
        "assunto": _limpa(dados.get("assunto")),
        "remetente": _limpa(dados.get("remetente")),
        "recebido_em": dados.get("recebido_em"),
        "mensagens": int(dados.get("mensagens") or 1),
        "numeros_nf": dados.get("numeros_nf") or None,
        "cliente_codigo": _limpa(dados.get("cliente_codigo")),
        "cliente_cnpj": _limpa(dados.get("cliente_cnpj")),
        "produtos": dados.get("produtos") or None,
        "atualizado_em": _agora(),
    }

    if achado:
        atual = achado[0]
        # Só cresce: o e-mail pode ter uma resposta nova com a NF que faltava,
        # mas uma releitura não pode APAGAR o que já se sabia.
        mudou = []
        update = {"atualizado_em": campos["atualizado_em"]}
        for k in ("assunto", "remetente", "recebido_em", "numeros_nf",
                  "cliente_codigo", "cliente_cnpj", "produtos"):
            novo = campos.get(k)
            if novo and novo != atual.get(k):
                update[k] = novo
                mudou.append(k)
        if campos["mensagens"] > int(atual.get("mensagens") or 0):
            update["mensagens"] = campos["mensagens"]
            mudou.append("mensagens")
        if not mudou:
            return {"acao": "nada", "id": atual["id"]}
        hist = list(atual.get("historico") or [])
        hist.append(_passo(None, "conversa atualizada pelo e-mail: %s" % ", ".join(mudou)))
        update["historico"] = hist
        db.table("devolucoes").update(update).eq("id", atual["id"]).execute()
        return {"acao": "atualizado", "id": atual["id"], "mudou": mudou}

    novo = {
        **campos,
        "origem": "EMAIL",
        "conversa_id": conversa,
        "status": "NOVA",
        "historico": [_passo(None, "caso aberto pelo e-mail")],
        "cliente_id": _cliente_por_codigo_ou_cnpj(db, campos["cliente_codigo"],
                                                  campos["cliente_cnpj"]),
        "criado_em": _agora(),
    }
    r = db.table("devolucoes").insert(novo).execute().data
    return {"acao": "criado", "id": r[0]["id"] if r else None}


def _cliente_por_codigo_ou_cnpj(db, codigo: Optional[str], cnpj: Optional[str]):
    """Liga ao cadastro quando dá. Quando não dá, fica sem — e a tela pergunta."""
    try:
        if codigo:
            r = db.table("clientes").select("id").eq("codigo", codigo).execute().data
            if r:
                return r[0]["id"]
        if cnpj:
            so_numeros = "".join(c for c in cnpj if c.isdigit())
            r = db.table("clientes").select("id, cnpj").limit(5000).execute().data
            for c in r:
                if "".join(ch for ch in str(c.get("cnpj") or "") if ch.isdigit()) == so_numeros:
                    return c["id"]
    except Exception:
        pass
    return None


def criar_manual(dados: dict, usuario: UsuarioOut) -> dict:
    """Devolução combinada por telefone, ou que o e-mail não pegou.

    Existe porque nem toda devolução nasce de e-mail, e uma tela que só aceita o
    que o motor traz obriga a pessoa a inventar um e-mail para poder registrar.
    """
    db = get_service_db()
    assunto = _limpa(dados.get("assunto"))
    if not assunto:
        raise HTTPException(422, "Diga do que se trata a devolução.")
    novo = {
        "origem": "MANUAL",
        "assunto": assunto,
        "remetente": usuario.nome,
        "recebido_em": dados.get("recebido_em") or _agora(),
        "numeros_nf": dados.get("numeros_nf") or None,
        "cliente_id": dados.get("cliente_id"),
        "cliente_codigo": _limpa(dados.get("cliente_codigo")),
        "motivo": _limpa(dados.get("motivo")),
        "observacao": _limpa(dados.get("observacao")),
        "status": "NOVA",
        "historico": [_passo(usuario, "caso aberto na tela")],
        "criado_em": _agora(),
        "atualizado_em": _agora(),
    }
    r = db.table("devolucoes").insert(novo).execute().data
    return r[0] if r else {}


def listar(incluir_resolvidas: bool = False) -> dict:
    db = get_service_db()
    linhas = []
    for off in range(0, 20000, 1000):
        b = db.table("devolucoes").select("*, clientes(nome, codigo)")\
            .eq("ativo", True).order("recebido_em", desc=True)\
            .limit(1000).offset(off).execute().data
        linhas += b
        if len(b) < 1000:
            break

    saida = []
    for d in linhas:
        resolvida = d.get("status") in FINAIS
        if resolvida and not incluir_resolvidas:
            continue
        cli = d.get("clientes") or {}
        saida.append({
            **{k: d.get(k) for k in (
                "id", "origem", "conversa_id", "assunto", "remetente", "recebido_em",
                "mensagens", "numeros_nf", "cliente_codigo", "cliente_cnpj",
                "cliente_id", "produtos", "status", "motivo", "observacao",
                "responsavel", "historico", "resolvido_em", "resolucao",
                "criado_em", "atualizado_em")},
            "cliente_nome": cli.get("nome"),
            "status_label": STATUS.get(d.get("status"), d.get("status")),
            "dias_parada": _dias(d.get("recebido_em")),
            "resolvida": resolvida,
            # O que falta para o caso ficar completo. É o que a tela cobra, e o
            # motivo de o motor poder entregar um caso pela metade sem culpa.
            "falta": _falta(d),
        })
    abertas = [x for x in saida if not x["resolvida"]]
    return {
        "devolucoes": saida,
        "abertas": len(abertas),
        "status": STATUS,
    }


def _falta(d: dict) -> list:
    falta = []
    if not (d.get("numeros_nf") or []):
        falta.append("o número da NF")
    if not d.get("cliente_id"):
        falta.append("o cliente")
    if not _limpa(d.get("motivo")):
        falta.append("o motivo")
    return falta


def _dias(iso) -> Optional[int]:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return max(0, (datetime.now(timezone.utc) - d).days)
    except Exception:
        return None


def atualizar(devolucao_id: str, dados: dict, usuario: UsuarioOut) -> dict:
    """Completa o que o e-mail não trouxe e move o caso adiante."""
    db = get_service_db()
    r = db.table("devolucoes").select("*").eq("id", devolucao_id).execute().data
    if not r:
        raise HTTPException(404, "Devolução não encontrada.")
    atual = r[0]

    EDITAVEIS = ("numeros_nf", "cliente_id", "cliente_codigo", "motivo",
                 "observacao", "responsavel", "status", "resolucao")
    update = {"atualizado_em": _agora()}
    mudancas = []
    for k in EDITAVEIS:
        if k not in dados:
            continue
        novo = dados[k]
        if k in ("motivo", "observacao", "responsavel", "cliente_codigo", "resolucao"):
            novo = _limpa(novo)
        if novo == atual.get(k):
            continue
        if k == "status":
            if novo not in STATUS:
                raise HTTPException(422, "Status '%s' não existe." % novo)
            mudancas.append("status: %s → %s" % (STATUS.get(atual.get("status"), "—"),
                                                 STATUS.get(novo)))
        else:
            mudancas.append(k)
        update[k] = novo

    if not mudancas:
        raise HTTPException(422, "Nada para alterar.")

    # Fechar carimba a data; reabrir a tira. Sem isso um caso reaberto continuaria
    # contando como resolvido no dia em que foi fechado.
    if "status" in update:
        update["resolvido_em"] = _agora() if update["status"] in FINAIS else None

    hist = list(atual.get("historico") or [])
    hist.append(_passo(usuario, "; ".join(mudancas)))
    update["historico"] = hist
    db.table("devolucoes").update(update).eq("id", devolucao_id).execute()
    return db.table("devolucoes").select("*").eq("id", devolucao_id).execute().data[0]


def excluir(devolucao_id: str, motivo: str, usuario: UsuarioOut) -> dict:
    """Some da tela, não do banco.

    Devolução aberta por engano (ou e-mail que não era devolução) precisa sair da
    fila. Apagar a linha destruiria o rastro e deixaria o motor recriá-la na
    rodada seguinte; `ativo = false` resolve os dois.
    """
    if len((motivo or "").strip()) < 3:
        raise HTTPException(422, "Diga por que este caso não é uma devolução.")
    db = get_service_db()
    r = db.table("devolucoes").select("*").eq("id", devolucao_id).execute().data
    if not r:
        raise HTTPException(404, "Devolução não encontrada.")
    hist = list(r[0].get("historico") or [])
    hist.append(_passo(usuario, "removido da lista: %s" % motivo.strip()))
    db.table("devolucoes").update({
        "ativo": False, "historico": hist, "atualizado_em": _agora(),
    }).eq("id", devolucao_id).execute()
    return {"ok": True}
