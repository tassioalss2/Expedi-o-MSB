"""Caixa de entrada da licitação — a triagem que saiu do Excel.

O motor lê o Outlook duas vezes por dia, extrai do ANEXO do pedido o produto, a
quantidade e o valor, e manda tudo para cá. Esta camada guarda, agrupa por nota
de empenho e promove a entrada a demanda quando a triagem decide.

A regra que rege o módulo inteiro: **sincronizar nunca sobrescreve o que uma
pessoa decidiu**. O motor roda de novo sobre a mesma janela de dias e passaria
por cima da triagem do time a cada rodada. Campo de máquina (assunto, itens do
anexo, prioridade calculada) é atualizado; campo de gente (situação,
observação, cliente escolhido, demanda gerada) só muda quando alguém muda.

Por que o cliente é um problema à parte: `licitacao_demandas.cliente_id` é
obrigatório, e o e-mail não diz quem é o cliente de forma utilizável. Dos 3.853
clientes do cadastro, 48 têm CNPJ, e nenhum hospital de licitação está entre
eles. Casar por nome erra feio — ligou "HOSPITAL UNIVERSITÁRIO LAURO WANDERLEY"
a uma pessoa física chamada Wanderley, então isso nunca é aplicado sozinho.

Medido nas 250 solicitações reais de julho a setembro/2026, agrupadas em 218
casos, na ordem em que `resolve()` tenta:

    CNPJ lido no anexo, via de-para de órgãos   81 casos (37%)
    a NE já tem demanda no app                 130 casos (60%)
    nenhuma chave                                7 casos ( 3%)  — 5 sem anexo

Ou seja, 97% resolvem sem ninguém digitar nada, e a chave que mais rende não é
o CNPJ: é a nota de empenho que JÁ virou demanda. Isso também revelou o custo
real da planilha — 130 casos estavam sendo trabalhados nos dois lugares, o
Excel e o painel, sem nenhuma ligação entre eles. Por isso `sincronizar` liga a
entrada à demanda existente em vez de convidar a criar outra: criar seria o
pedido duplicado que este processo existe para evitar.
"""
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import UsuarioOut

# Campos que a sincronização pode atualizar: são derivados do e-mail e do anexo,
# e se o motor melhorar a extração o registro deve melhorar também.
_CAMPOS_DA_MAQUINA = (
    "recebido_em", "pasta", "assunto", "corpo", "tipo", "prioridade", "motivo",
    "empenhos", "contrato", "pregao", "itens", "anexos", "cnpj_orgao", "orgao_texto",
)
SITUACOES = ("NAO", "PARCIAL", "SIM")


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hoje_brt():
    return datetime.now(timezone(timedelta(hours=-3))).date()


def _digitos(s) -> str:
    return re.sub(r"\D", "", str(s or ""))


def _demandas_por_empenho(db) -> dict:
    """Nota de empenho → demanda que já existe no app.

    Esta é a chave que mais resolve, e por um motivo que só apareceu ao medir:
    130 dos 218 casos da caixa de entrada citam uma NE que JÁ virou demanda.
    O trabalho estava sendo feito em dois lugares — a planilha e o painel — sem
    nenhuma ligação entre eles. Era esse o custo real do Excel.

    Serve para duas coisas ao mesmo tempo: traz o cliente (que a demanda já tem)
    e liga a entrada à demanda, para a tela dizer "já existe, é esta" em vez de
    convidar a criar outra — que seria o pedido duplicado.
    """
    mapa: dict[str, dict] = {}
    rows = db.table("licitacao_demandas")\
        .select("id, numero, cliente_id, etapa, criado_em")\
        .eq("ativo", True).limit(3000).execute().data
    # Mais recente por último: quando a mesma NE tem duas demandas (2ª remessa),
    # a que interessa é a atual.
    rows.sort(key=lambda d: d.get("criado_em") or "")
    for d in rows:
        num = str(d.get("numero") or "").strip().upper()
        if num and d.get("cliente_id"):
            mapa[num] = d
    return mapa


# ── sincronização a partir do motor ─────────────────────────────────────────
def sincronizar(lote: list[dict]) -> dict:
    """Grava o que o motor leu. Idempotente pela chave do e-mail.

    Devolve o que fez, porque o motor registra isso no log dele e é por ali que
    se descobre uma rodada que não entrou.
    """
    if not lote:
        return {"recebidos": 0, "criados": 0, "atualizados": 0, "sem_cliente": 0}

    db = get_service_db()
    chaves = [c for c in (str(e.get("chave") or "").strip() for e in lote) if c]
    if not chaves:
        raise HTTPException(400, "nenhum registro do lote tem chave")

    # Busca em blocos: o `in_` do PostgREST vai na URL e estoura com centenas
    # de chaves de uma vez.
    existentes: dict[str, dict] = {}
    for i in range(0, len(chaves), 100):
        achados = db.table("licitacao_entrada").select("*")\
            .in_("chave", chaves[i:i + 100]).execute().data
        for r in achados:
            existentes[r["chave"]] = r

    depara = {o["cnpj"]: o["cliente_id"] for o in
              db.table("licitacao_orgaos").select("cnpj, cliente_id").limit(2000).execute().data}
    por_ne = _demandas_por_empenho(db)

    def resolve(e, cnpj):
        """Cliente e demanda que a entrada herda, sem ninguem digitar nada.

        Ordem: o CNPJ do anexo primeiro, porque e chave exata do orgao; a NE
        depois, porque a demanda pode ter sido criada com o cliente errado e o
        de-para e o registro conferido por gente. Devolve (cliente_id,
        demanda_id) — qualquer um pode vir vazio.
        """
        cli = depara.get(cnpj)
        dem = None
        for ne in (e.get('empenhos') or []):
            d = por_ne.get(str(ne).strip().upper())
            if d:
                dem = d['id']
                cli = cli or d['cliente_id']
                break
        return cli, dem

    criados = atualizados = sem_cliente = ligados = 0
    for e in lote:
        chave = str(e.get("chave") or "").strip()
        if not chave:
            continue
        campos = {k: e.get(k) for k in _CAMPOS_DA_MAQUINA if k in e}
        campos["atualizado_em"] = _agora()
        cnpj = _digitos(e.get("cnpj_orgao"))
        campos["cnpj_orgao"] = cnpj or None

        antes = existentes.get(chave)
        if antes is None:
            campos["chave"] = chave
            # O de-para resolve o cliente na criação. Se não resolver, a entrada
            # nasce sem cliente e aparece na tela de órgãos pendentes — visível,
            # não perdida.
            cli, dem = resolve(e, cnpj)
            campos["cliente_id"] = cli
            if dem:
                campos["demanda_id"] = dem
                ligados += 1
            campos["sugestao"] = e.get("sugestao")
            db.table("licitacao_entrada").insert(campos).execute()
            criados += 1
            if not campos["cliente_id"]:
                sem_cliente += 1
            continue

        # Registro que já existe: nada de campo humano entra aqui. O cliente é a
        # única exceção parcial — se ainda está vazio e o de-para agora resolve,
        # preenche; se alguém já escolheu, não toca.
        cli, dem = resolve(e, cnpj)
        if not antes.get("cliente_id") and cli:
            campos["cliente_id"] = cli
        # A ligacao com a demanda tambem se completa depois: a demanda pode ter
        # nascido dias apos o e-mail. Nunca REtroca uma ligacao existente.
        if not antes.get("demanda_id") and dem:
            campos["demanda_id"] = dem
            ligados += 1
        # A sugestão do cruzamento volta a valer se mudou de texto: é informação
        # nova sobre o caso, e quem já leu a anterior precisa ver esta.
        nova_sug = e.get("sugestao")
        if nova_sug and nova_sug != (antes.get("sugestao") or ""):
            campos["sugestao"] = nova_sug
            campos["sugestao_lida"] = False
        db.table("licitacao_entrada").update(campos).eq("chave", chave).execute()
        atualizados += 1
        if not (campos.get("cliente_id") or antes.get("cliente_id")):
            sem_cliente += 1

    return {"recebidos": len(lote), "criados": criados, "atualizados": atualizados,
            "sem_cliente": sem_cliente, "ligados_a_demanda": ligados}


# ── leitura: a caixa de entrada agrupada por nota de empenho ────────────────
def _norm(s) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Z0-9 ]", " ", s.upper())


# Palavras que quase todo hospital público tem no nome e que, por isso, não
# distinguem ninguém. Sem tirá-las, "HOSPITAL UNIVERSITARIO X" casa com
# "HOSPITAL UNIVERSITARIO Y" com nota alta.
_VAZIAS = {
    "DE", "DA", "DO", "DAS", "DOS", "E", "HOSPITAL", "HOSP", "UNIVERSITARIO",
    "UNIVERSITARIA", "LTDA", "SA", "EMPRESA", "BRASILEIRA", "SERVICOS",
    "HOSPITALARES", "FUNDACAO", "INSTITUTO", "CENTRO", "REAL", "CLINICAS",
    "FACULDADE", "MEDICINA", "SAUDE", "GERAL", "ESTADO", "MUNICIPAL", "FEDERAL",
}


def _tokens(s) -> set:
    return {t for t in _norm(s).split() if len(t) > 2 and t not in _VAZIAS}


def _dias_parados(recebido_em) -> int:
    try:
        dt = datetime.fromisoformat(str(recebido_em).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, (_hoje_brt() - dt.astimezone(timezone(timedelta(hours=-3))).date()).days)
    except Exception:
        return 0


def listar(situacao: Optional[str] = None, dias: int = 60) -> list[dict]:
    """A caixa de entrada, um card por nota de empenho.

    O card herda dos e-mails o pior caso, que é o que precisa de atenção: a
    prioridade mais crítica e a data do primeiro e-mail (é dela que se contam os
    dias parados — um pedido cobrado três vezes está parado desde o primeiro).
    """
    db = get_service_db()
    corte = (_hoje_brt() - timedelta(days=dias)).isoformat()
    q = db.table("licitacao_entrada").select("*, clientes(nome)")\
        .eq("ativo", True).gte("recebido_em", corte)
    if situacao:
        q = q.eq("situacao", situacao)
    regs = q.limit(2000).execute().data

    # Um e-mail que cita duas NEs entra nos dois grupos: não dá para escolher
    # qual é a certa por conta própria (há um caso real de erro de digitação do
    # órgão, "2026NE001167 / 2026NE01167").
    grupos: dict[str, list[dict]] = {}
    for r in regs:
        for ne in (r.get("empenhos") or [None]):
            chave = "NE:%s" % ne if ne else "EM:%s" % r["chave"]
            grupos.setdefault(chave, []).append(r)

    cards = []
    for chave, membros in grupos.items():
        membros.sort(key=lambda x: x.get("recebido_em") or "")
        primeiro, ultimo = membros[0], membros[-1]

        def primeiro_com(campo):
            return next((m[campo] for m in membros if m.get(campo)), None)

        itens, vistos = [], set()
        for m in membros:
            for i in (m.get("itens") or []):
                # O órgão reenvia o mesmo empenho e cada reenvio traz o anexo de
                # novo. Repetir aqui faria parecer que ele pediu o dobro.
                assinatura = (i.get("qtd"), i.get("valor_unitario"), i.get("codigo_msb"))
                if assinatura in vistos:
                    continue
                vistos.add(assinatura)
                itens.append(i)

        situacoes = {m.get("situacao") for m in membros}
        cliente = next((m["clientes"]["nome"] for m in membros
                        if m.get("clientes") and m["clientes"].get("nome")), None)
        cards.append({
            "chave": chave,
            "empenho": chave[3:] if chave.startswith("NE:") else None,
            "assunto": primeiro.get("assunto"),
            "recebido_em": primeiro.get("recebido_em"),
            "ultimo_em": ultimo.get("recebido_em"),
            "dias_parados": _dias_parados(primeiro.get("recebido_em")),
            "prioridade": min(m.get("prioridade") or 5 for m in membros),
            "motivo": primeiro.get("motivo"),
            "tipo": primeiro_com("tipo"),
            "contrato": primeiro_com("contrato"),
            "pregao": primeiro_com("pregao"),
            "cliente_id": primeiro_com("cliente_id"),
            "cliente_nome": cliente,
            "orgao_texto": primeiro_com("orgao_texto"),
            "cnpj_orgao": primeiro_com("cnpj_orgao"),
            "demanda_id": primeiro_com("demanda_id"),
            # "Sim" só quando TODOS os e-mails da NE estão resolvidos. Um card
            # verde com um e-mail em aberto dentro é pior que nenhum card.
            "situacao": ("SIM" if situacoes == {"SIM"}
                         else "PARCIAL" if situacoes & {"SIM", "PARCIAL"} else "NAO"),
            "itens": itens,
            "valor_total": round(sum(float(i.get("valor_total") or 0) for i in itens), 2),
            "observacoes": [m["observacao"] for m in membros if (m.get("observacao") or "").strip()],
            "sugestoes": [m["sugestao"] for m in membros
                          if (m.get("sugestao") or "").strip() and not m.get("sugestao_lida")],
            "anexos_com_problema": [a for m in membros for a in (m.get("anexos") or [])
                                    if a.get("escaneado") or a.get("erro")],
            "emails": [{
                "id": m["id"], "chave": m["chave"], "recebido_em": m.get("recebido_em"),
                "assunto": m.get("assunto"), "corpo": m.get("corpo"), "pasta": m.get("pasta"),
                "situacao": m.get("situacao"), "observacao": m.get("observacao"),
            } for m in membros],
        })

    # Mais crítico primeiro; dentro da mesma criticidade, o que está parado há
    # mais tempo. O que já foi resolvido desce.
    cards.sort(key=lambda c: (c["situacao"] == "SIM", c["prioridade"], -c["dias_parados"]))
    return cards


def _emails_do_grupo(chave: str, colunas: str = "*") -> list[dict]:
    """Os e-mails de um grupo — uma nota de empenho, ou um e-mail solto.

    O filtro de "array contém" é feito em Python, e não no banco, porque o
    cliente deste projeto não expõe o operador `cs` do PostgREST: não tem
    `.contains()` nem `.filter()`. Custa pouco — a caixa de entrada guarda
    centenas de linhas, não milhões — e a alternativa seria acrescentar um
    método a um wrapper que o app inteiro usa, mudança larga para um ganho que
    aqui não existe.
    """
    db = get_service_db()
    if chave.startswith("EM:"):
        return db.table("licitacao_entrada").select(colunas).eq("chave", chave[3:]).execute().data
    if not chave.startswith("NE:"):
        raise HTTPException(400, "chave de grupo inválida: %s" % chave)
    ne = chave[3:]
    # `empenhos` vem junto mesmo quando o chamador não pediu: é por ele que se filtra.
    pedido = colunas if colunas == "*" else "%s, empenhos" % colunas
    todos = db.table("licitacao_entrada").select(pedido).eq("ativo", True)\
        .limit(5000).execute().data
    return [r for r in todos if ne in (r.get("empenhos") or [])]


def triar(entrada_id: str, usuario: UsuarioOut, situacao: Optional[str] = None,
          observacao: Optional[str] = None, cliente_id: Optional[str] = None) -> dict:
    """O que uma pessoa decide sobre um e-mail. É o campo humano do registro."""
    db = get_service_db()
    reg = db.table("licitacao_entrada").select("*").eq("id", entrada_id).execute().data
    if not reg:
        raise HTTPException(404, "entrada não encontrada")

    campos = {"atualizado_em": _agora()}
    if situacao is not None:
        if situacao not in SITUACOES:
            raise HTTPException(400, "situação inválida: %s" % situacao)
        campos["situacao"] = situacao
        # A sugestão já cumpriu o papel de avisar; continuar aparecendo depois
        # de tratada vira ruído.
        campos["sugestao_lida"] = True
    if observacao is not None:
        campos["observacao"] = observacao.strip() or None
    if cliente_id is not None:
        campos["cliente_id"] = cliente_id
    db.table("licitacao_entrada").update(campos).eq("id", entrada_id).execute()
    return db.table("licitacao_entrada").select("*").eq("id", entrada_id).execute().data[0]


def triar_grupo(chave: str, usuario: UsuarioOut, situacao: Optional[str] = None,
                observacao: Optional[str] = None, cliente_id: Optional[str] = None) -> dict:
    """A mesma decisão, aplicada à nota de empenho inteira.

    É como o time trabalha: resolve a NE, não o e-mail. A observação fica no
    primeiro e-mail do grupo — repeti-la em todos encheria a tela do mesmo texto.
    """
    regs = _emails_do_grupo(chave, "id, recebido_em")
    if not regs:
        raise HTTPException(404, "nenhum e-mail para a chave %s" % chave)

    regs.sort(key=lambda x: x.get("recebido_em") or "")
    for pos, r in enumerate(regs):
        triar(r["id"], usuario, situacao=situacao, cliente_id=cliente_id,
              observacao=observacao if pos == 0 else None)
    return {"chave": chave, "afetados": len(regs)}


# ── de-para dos órgãos ──────────────────────────────────────────────────────
def orgaos_pendentes() -> list[dict]:
    """Os órgãos que apareceram nos e-mails e ainda não têm cliente definido.

    Cada um traz até três candidatos do cadastro, por semelhança de nome. É
    sugestão, não decisão: o casamento por nome erra o bastante para nunca ser
    aplicado sozinho.
    """
    db = get_service_db()
    regs = db.table("licitacao_entrada")\
        .select("cnpj_orgao, orgao_texto, assunto, recebido_em")\
        .is_("cliente_id", "null").eq("ativo", True).limit(2000).execute().data
    ja = {o["cnpj"] for o in
          db.table("licitacao_orgaos").select("cnpj").limit(2000).execute().data}

    clientes = []
    passo, ini = 1000, 0
    while True:
        bloco = db.table("clientes").select("id, nome, codigo")\
            .eq("ativo", True).limit(passo).offset(ini).execute().data
        clientes += bloco
        ini += passo
        if len(bloco) < passo:
            break
    indice = [(c, _tokens(c["nome"])) for c in clientes]

    por_cnpj: dict[str, dict] = {}
    for r in regs:
        cnpj = r.get("cnpj_orgao")
        if not cnpj or cnpj in ja:
            continue
        alvo = por_cnpj.setdefault(cnpj, {
            "cnpj": cnpj, "nome_documento": r.get("orgao_texto"),
            "quantidade": 0, "ultimo_assunto": r.get("assunto"),
            "ultimo_em": r.get("recebido_em"),
        })
        alvo["quantidade"] += 1
        if not alvo["nome_documento"] and r.get("orgao_texto"):
            alvo["nome_documento"] = r["orgao_texto"]
        if (r.get("recebido_em") or "") > (alvo["ultimo_em"] or ""):
            alvo["ultimo_em"] = r["recebido_em"]
            alvo["ultimo_assunto"] = r.get("assunto")

    saida = []
    for cnpj, o in por_cnpj.items():
        alvo = _tokens(o["nome_documento"])
        candidatos = []
        if alvo:
            notas = []
            for c, toks in indice:
                if not toks:
                    continue
                nota = len(alvo & toks) / len(alvo | toks)
                if nota > 0:
                    notas.append((nota, c))
            notas.sort(key=lambda x: -x[0])
            candidatos = [{"id": c["id"], "nome": c["nome"], "codigo": c.get("codigo"),
                           "semelhanca": round(n, 2)} for n, c in notas[:3]]
        o["candidatos"] = candidatos
        saida.append(o)

    saida.sort(key=lambda o: -o["quantidade"])
    return saida


def mapear_orgao(cnpj: str, cliente_id: str, usuario: UsuarioOut,
                 nome_documento: Optional[str] = None) -> dict:
    """Liga um CNPJ de órgão a um cliente, e aplica em tudo que estava esperando.

    O preenchimento retroativo é o ponto: sem ele, definir o de-para hoje só
    valeria para o e-mail de amanhã, e o que já chegou continuaria sem cliente.
    """
    cnpj = _digitos(cnpj)
    if len(cnpj) != 14:
        raise HTTPException(400, "CNPJ inválido: %s" % cnpj)
    db = get_service_db()
    if not db.table("clientes").select("id").eq("id", cliente_id).execute().data:
        raise HTTPException(404, "cliente não encontrado")

    existente = db.table("licitacao_orgaos").select("id").eq("cnpj", cnpj).execute().data
    campos = {"cnpj": cnpj, "cliente_id": cliente_id, "nome_documento": nome_documento,
              "confirmado_por": str(usuario.id), "atualizado_em": _agora()}
    if existente:
        db.table("licitacao_orgaos").update(campos).eq("cnpj", cnpj).execute()
    else:
        db.table("licitacao_orgaos").insert(campos).execute()

    # Só onde ninguém escolheu ainda: uma correção de de-para não pode desfazer
    # a escolha que alguém fez a mão para um caso específico.
    afetados = db.table("licitacao_entrada").update(
        {"cliente_id": cliente_id, "atualizado_em": _agora()}
    ).eq("cnpj_orgao", cnpj).is_("cliente_id", "null").execute().data
    return {"cnpj": cnpj, "cliente_id": cliente_id, "entradas_atualizadas": len(afetados or [])}


def listar_orgaos() -> list[dict]:
    db = get_service_db()
    return db.table("licitacao_orgaos").select("*, clientes(nome, codigo)")\
        .limit(2000).execute().data


# ── promover a entrada a demanda ────────────────────────────────────────────
def _produto_por_codigo(db, codigos: list[str]) -> dict:
    """Mapa código → produto, para o item chegar na demanda já ligado ao catálogo.

    O código vem do próprio documento do órgão: a EBSERH escreve
    'MSB MEDICAL SYSTEM DO BRASIL/73339' e o HCPA 'Marca:MSB Modelo:T REF
    51202'. Quando o órgão não repete o código, sobra a descrição CATMAT, que é
    genérica de propósito e serve para vários itens — aí o produto fica em
    branco e quem atende escolhe.
    """
    limpos = sorted({str(c).strip() for c in codigos if str(c or "").strip()})
    if not limpos:
        return {}
    achados: dict[str, dict] = {}
    for i in range(0, len(limpos), 50):
        for p in db.table("produtos").select("id, codigo, descricao")\
                .in_("codigo", limpos[i:i + 50]).execute().data:
            achados[str(p["codigo"]).strip()] = p
    return achados


def promover(chave: str, usuario: UsuarioOut, extra: Optional[dict] = None) -> dict:
    """Cria a demanda a partir do que já está na caixa de entrada.

    A entrada guarda o pedido como o órgão mandou; a demanda é o trabalho que a
    operação vai fazer. Promover é o momento em que uma vira a outra — e é por
    isso que a triagem deixa de ser uma marca em planilha e passa a ligar o
    e-mail ao card que anda no painel.

    O que não dá para adivinhar vem em `extra`, preenchido pela tela: o
    comunicado de uso exige paciente, prontuário e data do procedimento, que não
    estão no anexo do pedido.
    """
    from app.services import licitacao_demanda_service
    from app.models.schemas import DemandaCreate, DemandaItem

    extra = extra or {}
    db = get_service_db()
    regs = _emails_do_grupo(chave, "*")
    if not regs:
        raise HTTPException(404, "nenhum e-mail para a chave %s" % chave)

    ja = next((r["demanda_id"] for r in regs if r.get("demanda_id")), None)
    if ja and not extra.get("permitir_segunda"):
        # Duas demandas para a mesma nota de empenho é o pedido duplicado que
        # este processo existe para evitar. Quem precisa de uma segunda remessa
        # pede explicitamente.
        raise HTTPException(409, "esta nota de empenho já gerou a demanda %s" % ja)

    regs.sort(key=lambda x: x.get("recebido_em") or "")
    base = regs[0]
    cliente_id = extra.get("cliente_id") or next(
        (r["cliente_id"] for r in regs if r.get("cliente_id")), None)
    if not cliente_id:
        raise HTTPException(
            422, "defina o cliente antes de promover: o CNPJ %s não está no de-para de órgãos"
                 % (base.get("cnpj_orgao") or "(não lido)"))

    tipo = extra.get("tipo_operacao") or base.get("tipo") or "VENDA_DIRETA"
    if tipo == "OUTRO":
        raise HTTPException(422, "escolha o tipo da operação: o e-mail não deixou claro")

    # Junta os itens de todos os e-mails da NE, sem repetir o mesmo reenvio.
    itens_brutos, vistos = [], set()
    for r in regs:
        for i in (r.get("itens") or []):
            assinatura = (i.get("qtd"), i.get("valor_unitario"), i.get("codigo_msb"))
            if assinatura in vistos:
                continue
            vistos.add(assinatura)
            itens_brutos.append(i)

    catalogo = _produto_por_codigo(db, [i.get("codigo_msb") for i in itens_brutos])
    itens = []
    for i in itens_brutos:
        cod = str(i.get("codigo_msb") or "").strip()
        p = catalogo.get(cod)
        itens.append(DemandaItem(
            produto_id=p["id"] if p else None,
            codigo=(p["codigo"] if p else cod) or None,
            descricao=(p["descricao"] if p else i.get("descricao")) or None,
            qtd=float(i.get("qtd") or 0),
            valor=float(i.get("valor_unitario") or 0),
        ))

    payload = DemandaCreate(
        tipo_operacao=tipo,
        numero_pregao=extra.get("numero_pregao") or base.get("pregao"),
        numero=extra.get("numero") or (base.get("empenhos") or [None])[0],
        cliente_id=cliente_id,
        canal=extra.get("canal"),
        prazo=extra.get("prazo"),
        # A prioridade da entrada é 1..5 (planilha); a demanda fala em nomes.
        prioridade=extra.get("prioridade") or (
            "CRITICA" if (base.get("prioridade") or 5) <= 1
            else "ALTA" if (base.get("prioridade") or 5) == 2 else "NORMAL"),
        observacao=extra.get("observacao") or _observacao_da_entrada(regs),
        itens=itens,
        nome_paciente=extra.get("nome_paciente"),
        prontuario=extra.get("prontuario"),
        numero_nf=extra.get("numero_nf"),
        data_procedimento=extra.get("data_procedimento"),
        notas=extra.get("notas") or [],
    )
    demanda = licitacao_demanda_service.criar_demanda(payload)

    # Todos os e-mails da NE passam a apontar para a demanda: é o que impede o
    # mesmo empenho de ser trabalhado duas vezes por duas pessoas.
    for r in regs:
        db.table("licitacao_entrada").update({
            "demanda_id": demanda["id"], "situacao": "PARCIAL",
            "cliente_id": cliente_id, "atualizado_em": _agora(),
        }).eq("id", r["id"]).execute()

    return {"demanda": demanda, "emails_ligados": len(regs)}


def _observacao_da_entrada(regs: list[dict]) -> str:
    """De onde a demanda veio, em uma linha, para quem abrir o card entender."""
    base = regs[0]
    partes = ["Da caixa de entrada da licitação: %s" % (base.get("assunto") or "")[:120]]
    if len(regs) > 1:
        partes.append("%d e-mails sobre esta nota de empenho" % len(regs))
    notas = [r["observacao"] for r in regs if (r.get("observacao") or "").strip()]
    if notas:
        partes.append("Triagem: %s" % " | ".join(notas)[:240])
    return ". ".join(partes)


# ── painel executivo ────────────────────────────────────────────────────────
def painel(dias: int = 30) -> dict:
    """Os números que o conselho pergunta, e só eles.

    A tela do operador mostra cada caso; esta responde outra pergunta: o setor
    está dando conta? Por isso os números são de fluxo (entrou, resolveu, está
    parado) e não a lista de tudo.

    O valor parado sai dos itens extraídos do anexo. Ele é um piso, não o total:
    24 dos anexos de pedido chegam escaneados (foto, sem texto) e desses não sai
    valor nenhum. Dizer isso é parte do número — `cobertura` conta quantos casos
    entraram na conta, para ninguém tratar um piso como se fosse o total.
    """
    db = get_service_db()
    corte = (_hoje_brt() - timedelta(days=dias)).isoformat()
    regs = db.table("licitacao_entrada").select("*")\
        .eq("ativo", True).gte("recebido_em", corte).limit(3000).execute().data

    cards = listar(dias=dias)
    abertos = [c for c in cards if c["situacao"] != "SIM"]

    faixas = {"ate_2": 0, "de_3_a_7": 0, "de_8_a_15": 0, "mais_de_15": 0}
    for c in abertos:
        d = c["dias_parados"]
        chave = ("ate_2" if d <= 2 else "de_3_a_7" if d <= 7
                 else "de_8_a_15" if d <= 15 else "mais_de_15")
        faixas[chave] += 1

    com_valor = [c for c in abertos if c["valor_total"] > 0]
    por_cliente: dict[str, dict] = {}
    for c in abertos:
        nome = c["cliente_nome"] or c["orgao_texto"] or "(órgão não identificado)"
        alvo = por_cliente.setdefault(nome, {"cliente": nome, "casos": 0, "valor": 0.0,
                                             "mais_antigo": 0})
        alvo["casos"] += 1
        alvo["valor"] = round(alvo["valor"] + c["valor_total"], 2)
        alvo["mais_antigo"] = max(alvo["mais_antigo"], c["dias_parados"])
    ranking = sorted(por_cliente.values(), key=lambda x: (-x["valor"], -x["casos"]))[:8]

    # Entrada por dia, para a linha do tempo. Conta e-mail, não card: é o volume
    # que chega na mesa do time.
    por_dia: dict[str, int] = {}
    for r in regs:
        dia = str(r.get("recebido_em") or "")[:10]
        if dia:
            por_dia[dia] = por_dia.get(dia, 0) + 1

    etapas = db.table("licitacao_demandas").select("etapa, criado_em")\
        .eq("ativo", True).limit(2000).execute().data
    por_etapa: dict[str, int] = {}
    for d in etapas:
        por_etapa[d["etapa"]] = por_etapa.get(d["etapa"], 0) + 1

    resolvidos = [c for c in cards if c["situacao"] == "SIM"]
    return {
        "periodo_dias": dias,
        "emails_recebidos": len(regs),
        "casos": len(cards),
        "abertos": len(abertos),
        "resolvidos": len(resolvidos),
        "criticos": sum(1 for c in abertos if c["prioridade"] <= 1),
        "sem_cliente": sum(1 for c in abertos if not c["cliente_id"]),
        "parados_por_faixa": faixas,
        "mais_antigo_dias": max((c["dias_parados"] for c in abertos), default=0),
        "valor_parado": round(sum(c["valor_total"] for c in com_valor), 2),
        "cobertura": {
            "casos_com_valor": len(com_valor),
            "casos_abertos": len(abertos),
            "casos_sem_valor_lido": len(abertos) - len(com_valor),
        },
        "por_cliente": ranking,
        "entrada_por_dia": [{"dia": d, "emails": n} for d, n in sorted(por_dia.items())],
        "demandas_por_etapa": por_etapa,
    }
