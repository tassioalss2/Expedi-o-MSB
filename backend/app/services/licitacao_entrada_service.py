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
casos:

    cliente veio da NE que já tinha demanda      31 casos (14%)
    resolvem com o de-para de órgãos preenchido  66 casos (30%)  — 26 órgãos
    nenhuma chave                               121 casos (56%)

Um aviso para quem for refazer essa conta: a primeira medição deu 97% e estava
errada. O mapa de NE→demanda foi montado sem descartar demandas com `numero`
vazio, e a chave `''` resultante casava com todo caso SEM nota de empenho —
inflando 30 para 130. `_demandas_por_empenho` descarta o vazio de propósito.

Os 56% sem chave assustam menos do que parece: dos que estão em aberto, só UM
tem item de anexo. O resto é comunicado de uso e e-mail administrativo
("SOLIC. DE NOTA: <paciente>", carta de correção) — mail que nunca teve anexo
de pedido e onde o cliente sempre seria digitado. Onde existe pedido de
verdade, a cadeia resolve.

Medir isso revelou o custo real da planilha: as NEs apareciam nos dois lugares,
o Excel e o painel, sem nenhuma ligação. Por isso `sincronizar` liga a entrada
à demanda existente em vez de convidar a criar outra — criar seria o pedido
duplicado que este processo existe para evitar.
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
    # Volatil de proposito: reescrito a cada rodada porque o EntryID muda quando
    # o e-mail e movido de pasta.
    "entry_id",
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
    from app.services import contratos_d365_service
    por_contrato, por_pregao = contratos_d365_service.mapa_para_resolucao(db)

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
        # O contrato MSB citado no e-mail e a chave que mais rende: 81 dos 214
        # casos, a frente do CNPJ (66) e da NE com demanda (31). Vem do export
        # de contratos do D365, que liga contrato -> codigo do cliente.
        if not cli:
            ct = str(e.get('contrato') or '').strip().upper()
            cli = por_contrato.get(ct)
        # O pregao e o ultimo recurso e so vale quando aponta um cliente unico:
        # ha pregao compartilhado por contratos de clientes diferentes, e
        # escolher um seria atribuir a venda ao hospital errado.
        if not cli:
            pg = re.sub(r'\s+', '', str(e.get('pregao') or ''))
            cli = por_pregao.get(pg)
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


# ── agrupamento: a segunda chave, quando não há nota de empenho ─────────────
# A regra original era só a NE, herdada da planilha. Ela deixa passar o caso
# mais irritante: o órgão reenvia a MESMA ordem de fornecimento quatro vezes,
# nenhuma delas cita NE, e o painel mostra quatro cards idênticos — 5 un ×
# R$ 398,00 para o mesmo hospital, com 24, 23, 17 e 14 dias. Foi o que o Tassio
# viu na tela.
#
# A chave que resolve NÃO é semelhança (assunto parecido, cliente igual, valor
# igual) — isso juntaria dois pedidos legítimos iguais do mesmo hospital, que
# acontece. É a IDENTIDADE DO DOCUMENTO: os quatro e-mails traziam o mesmo
# anexo, `SEI_63643428_Ordem_de_Servico...`, o mesmo número de documento. Mesmo
# papel é o mesmo pedido, e isso é fato, não estimativa.
_DOCUMENTO = (
    # SEI: 'SEI_63643428_...', 'SEI_SEDE - 64301571 - ...', 'Despacho___SEI_63907164'
    re.compile(r'SEI[_\s]*(?:SEDE)?[_\s-]*(\d{7,9})', re.I),
    # 'ORDEM DE FORNECIMENTO Nº 1911.26.0112/2026.03', 'OF 3785-2026'
    re.compile(r'(?:ordem\s+de\s+fornecimento|\bOF)\s*(?:n?[º°.:]?\s*)?'
               r'([\d][\d./-]{5,24}\d)', re.I),
    # 'AFP_160168 - 7', 'AF 29621.2026', 'AFC 493-2026'
    re.compile(r'\bAF[PC]?[_\s]*(?:n?[º°.:]?\s*)?([\d][\d./-]{4,20}\d)', re.I),
)


def _numero_do_documento(reg: dict) -> Optional[str]:
    """O número do documento citado, do nome do anexo ou do assunto.

    O anexo tem prioridade: o nome do arquivo é o que o sistema do órgão gerou,
    enquanto o assunto é digitado por gente e varia ("Ordem de fornecimento -
    MSB" quatro vezes, sem número nenhum).
    """
    fontes = [str(a.get("arquivo") or "") for a in (reg.get("anexos") or [])]
    fontes.append(str(reg.get("assunto") or ""))
    for texto in fontes:
        for rx in _DOCUMENTO:
            m = rx.search(texto)
            if m:
                bruto = m.group(1).strip(" .-/")
                # Normaliza separador: o mesmo documento chega como
                # '1911.26.0112/2026.03' no assunto e '1911.26.0112.2026.03' no
                # nome do arquivo.
                return re.sub(r"[^0-9]", ".", bruto).strip(".")
    return None


def _especifico(numero: str) -> bool:
    """Se o número identifica o documento sozinho, sem precisar do órgão.

    Um id do SEI ('63643428') e um número composto ('1911.26.0112.2026.03') não
    colidem entre órgãos. Já 'OF 3785/2026' é sequencial simples: dois hospitais
    podem ter a sua ordem 3785 no mesmo ano, e juntá-las esconderia trabalho.
    Números simples só agrupam quando o CNPJ do órgão também bate.
    """
    return len(re.sub(r"\D", "", numero)) >= 8 and numero.count(".") >= 3 \
        or bool(re.fullmatch(r"\d{7,9}", numero))


def _escopo_do_orgao(reg: dict) -> str:
    """Quem é o órgão, para separar documentos de número genérico.

    O cliente resolvido vem primeiro: é a entidade canônica do app, enquanto o
    CNPJ é o que o documento por acaso trouxe. Vazio quando não se sabe — e
    "não se sabe" é tratado como compatível em `agrupar`, não como um órgão
    próprio.
    """
    return str(reg.get("cliente_id") or reg.get("cnpj_orgao") or "").strip()


def chave_do_grupo(reg: dict) -> str:
    """A chave que decide quais e-mails são o mesmo caso.

    Ordem: nota de empenho, número do documento, e por último o próprio e-mail.
    A NE vem primeiro porque é o que a operação usa para falar do caso.
    """
    nes = reg.get("empenhos") or []
    if nes:
        return "NE:%s" % nes[0]
    numero = _numero_do_documento(reg)
    if numero:
        if _especifico(numero):
            return "DOC:%s" % numero
        escopo = _escopo_do_orgao(reg)
        if escopo:
            return "DOC:%s:%s" % (escopo, numero)
        # Número genérico e órgão desconhecido: fica isolado aqui e `agrupar`
        # decide se dá para encaixá-lo num grupo conhecido do mesmo documento.
        return "DOC?:%s:%s" % (numero, reg["chave"])
    return "EM:%s" % reg["chave"]


def agrupar(regs: list[dict]) -> dict[str, list[dict]]:
    """Os e-mails divididos em casos. Fonte única — a listagem e as ações de
    grupo usam esta mesma função, senão triar um card afetaria outro conjunto.

    Duas passadas. A primeira aplica `chave_do_grupo`. A segunda encaixa os
    e-mails de órgão desconhecido: quando o número do documento bate com UM
    único grupo conhecido, é o mesmo caso — o órgão só não foi lido naquele
    e-mail. Caso real: dois "Solicitacao de faturamento | AF 1925/2026 - PE
    90037/2025", com assunto idêntico, um com CNPJ e outro sem.

    "Um único" é a trava que importa. Se dois órgãos tiverem a AF 1925 na mesma
    janela, o desconhecido fica sozinho — fundir dois pedidos de verdade
    esconderia trabalho, que é o erro mais caro deste módulo.
    """
    grupos: dict[str, list[dict]] = {}
    for r in regs:
        nes = r.get("empenhos") or []
        if nes:
            # Cita duas NEs: entra nos dois grupos. Não dá para escolher qual é
            # a certa por conta própria.
            for ne in nes:
                grupos.setdefault("NE:%s" % ne, []).append(r)
        else:
            grupos.setdefault(chave_do_grupo(r), []).append(r)

    # Por número de documento, quais grupos de órgão CONHECIDO existem.
    conhecidos: dict[str, set] = {}
    for chave in grupos:
        if chave.startswith("DOC:") and chave.count(":") == 2:
            _, _escopo, numero = chave.split(":", 2)
            conhecidos.setdefault(numero, set()).add(chave)

    for chave in [k for k in grupos if k.startswith("DOC?:")]:
        numero = chave.split(":", 2)[1]
        destinos = conhecidos.get(numero) or set()
        if len(destinos) == 1:
            grupos[next(iter(destinos))].extend(grupos.pop(chave))
    return grupos


def _entrega_prevista(membros: list[dict]) -> Optional[str]:
    """A data em que o órgão exige a entrega, lida do anexo. ISO, ou None.

    É o único compromisso real do caso, e hoje 63% das demandas nascem sem
    prazo — o que faz "atrasado" ser medido por idade de e-mail em vez de
    promessa assumida. A ordem do SEI e a autorização do HCPA trazem essa data;
    quando mais de um anexo traz, vence a MAIS CEDO: é a que aperta.

    Vem em dd/mm/aaaa do documento. Data que não converte é descartada em
    silêncio — prazo errado é pior que prazo ausente, porque viraria atraso
    inventado no painel que o conselho olha.
    """
    achadas = []
    for m in membros:
        for a in (m.get("anexos") or []):
            bruta = str(a.get("entrega_prevista") or "").strip()
            if not re.match(r"^\d{2}/\d{2}/\d{4}$", bruta):
                continue
            try:
                d = datetime.strptime(bruta, "%d/%m/%Y").date()
            except ValueError:
                continue
            # Documento de licitação com data de entrega em 2019 ou em 2040 é
            # erro de leitura, não prazo.
            if 2020 <= d.year <= _hoje_brt().year + 2:
                achadas.append(d)
    return min(achadas).isoformat() if achadas else None


def listar(situacao: Optional[str] = None, dias: int = 60,
           tipo: Optional[str] = None) -> list[dict]:
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
    if tipo:
        # Filtra DEPOIS de trazer, e nao no banco: o tipo do caso e o do
        # primeiro e-mail que tem tipo, e filtrar no banco cortaria os irmaos
        # sem tipo e quebraria o agrupamento da NE.
        alvos = {r["chave"] for r in regs if (r.get("tipo") or "OUTRO") == tipo}
        nes = {ne for r in regs if r["chave"] in alvos for ne in (r.get("empenhos") or [])}
        regs = [r for r in regs
                if r["chave"] in alvos or (set(r.get("empenhos") or []) & nes)]

    # O andamento da demanda vem junto. Sem isto o card só sabe dizer "existe
    # uma demanda", e quem está na caixa de entrada teria de abrir a outra tela
    # para descobrir se o caso já virou OV ou já foi faturado — que é
    # exatamente a informação que faz alguém NÃO refazer um pedido.
    ids = {r["demanda_id"] for r in regs if r.get("demanda_id")}
    andamento: dict[str, dict] = {}
    if ids:
        lista = sorted(ids)
        for i in range(0, len(lista), 100):
            for d in db.table("licitacao_demandas")\
                    .select("id, etapa, ovs, numero_nf, gerado_ref, tipo_operacao")\
                    .in_("id", lista[i:i + 100]).execute().data:
                andamento[d["id"]] = d

    # Nome de quem assumiu cada caso. Uma consulta só, para os poucos usuários
    # que aparecem — e não uma por card.
    ids_quem = {r["tratativa_por"] for r in regs if r.get("tratativa_por")}
    quem: dict = {}
    if ids_quem:
        for u in db.table("usuarios").select("id, nome")\
                .in_("id", sorted(ids_quem)).execute().data:
            quem[u["id"]] = u["nome"]

    # O que o contrato MSB citado significa. O código sozinho ("MSB-000238") não
    # diz nada a quem olha; o título do contrato diz de que pregão e de que
    # família de produto o caso é ("PE 90080/2025 DIVERSOS").
    contratos: dict = {}
    citados = {c.strip().upper() for r in regs
               for c in str(r.get("contrato") or "").split(" / ") if c.strip()}
    if citados:
        lista = sorted(citados)
        for i in range(0, len(lista), 100):
            for ct in db.table("licitacao_contratos_d365")\
                    .select("contrato, titulo, pregao, nome_d365")\
                    .in_("contrato", lista[i:i + 100]).execute().data:
                contratos[ct["contrato"]] = ct

    # As anotacoes, uma consulta para toda a janela. O nome do autor entra junto:
    # nota sem autor num caso que passou por tres pessoas nao diz a quem
    # perguntar.
    notas: dict = {}
    ids_entrada = [r["id"] for r in regs]
    for i in range(0, len(ids_entrada), 100):
        for n in db.table("licitacao_entrada_notas")                .select("id, entrada_id, texto, autor_id, criado_em")                .in_("entrada_id", ids_entrada[i:i + 100]).limit(5000).execute().data:
            notas.setdefault(n["entrada_id"], []).append(n)
    ids_autor = {n["autor_id"] for v in notas.values() for n in v if n.get("autor_id")}
    autores: dict = {}
    if ids_autor:
        for u in db.table("usuarios").select("id, nome")                .in_("id", sorted(ids_autor)).execute().data:
            autores[u["id"]] = u["nome"]

    grupos = agrupar(regs)

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
            # Sem NE, o card precisa dizer QUAL documento e — quatro cards
            # escritos "Ordem de fornecimento - MSB" sao indistinguiveis.
            "documento": _numero_do_documento(primeiro) if not chave.startswith("NE:") else None,
            "assunto": primeiro.get("assunto"),
            "recebido_em": primeiro.get("recebido_em"),
            "ultimo_em": ultimo.get("recebido_em"),
            "dias_parados": _dias_parados(primeiro.get("recebido_em")),
            "prioridade": min(m.get("prioridade") or 5 for m in membros),
            "motivo": primeiro.get("motivo"),
            "tipo": primeiro_com("tipo"),
            "contrato": primeiro_com("contrato"),
            # O titulo do contrato citado, para o codigo interno significar algo
            # na tela. Quando o e-mail cita dois, vale o primeiro.
            "contrato_titulo": (contratos.get(
                str(primeiro_com("contrato") or "").split(" / ")[0].strip().upper(), {}
            ) or {}).get("titulo"),
            # Contrato citado que nao existe no export do D365 e erro de
            # digitacao ou referencia velha — e como o cliente vai sair errado.
            # Hoje sao zero das 114 citacoes, mas isso muda no dia em que
            # mudar.
            "contrato_desconhecido": bool(
                primeiro_com("contrato")
                and str(primeiro_com("contrato")).split(" / ")[0].strip().upper() not in contratos),
            "pregao": primeiro_com("pregao"),
            "cliente_id": primeiro_com("cliente_id"),
            "cliente_nome": cliente,
            "orgao_texto": primeiro_com("orgao_texto"),
            "cnpj_orgao": primeiro_com("cnpj_orgao"),
            "demanda_id": primeiro_com("demanda_id"),
            "demanda": andamento.get(primeiro_com("demanda_id")),
            "entrega_prevista": _entrega_prevista(membros),
            # Basta UM e-mail do grupo estar assumido: o caso e um so, e
            # quem assumiu marcou onde estava olhando.
            "em_tratativa": any(m.get("em_tratativa") for m in membros),
            "tratativa_por": next((m.get("tratativa_por") for m in membros
                                   if m.get("em_tratativa")), None),
            # O NOME de quem assumiu, não o id. Guardar quem assumiu só serve
            # se a tela disser a quem perguntar sobre um caso que está "sendo
            # tratado" há duas semanas.
            "tratativa_nome": quem.get(next((m.get("tratativa_por") for m in membros
                                             if m.get("em_tratativa")), None)),
            # "Sim" só quando TODOS os e-mails da NE estão resolvidos. Um card
            # verde com um e-mail em aberto dentro é pior que nenhum card.
            "situacao": ("SIM" if situacoes == {"SIM"}
                         else "PARCIAL" if situacoes & {"SIM", "PARCIAL"} else "NAO"),
            "itens": itens,
            "valor_total": round(sum(float(i.get("valor_total") or 0) for i in itens), 2),
            # Historico de anotacoes do caso — de todos os e-mails do grupo,
            # do mais recente para o mais antigo.
            "notas": sorted(
                [{"id": n["id"], "texto": n["texto"],
                  "autor": autores.get(n.get("autor_id")),
                  "quando": n.get("criado_em")}
                 for m in membros for n in notas.get(m["id"], [])],
                key=lambda n: n["quando"] or "", reverse=True),
            "sugestoes": [m["sugestao"] for m in membros
                          if (m.get("sugestao") or "").strip() and not m.get("sugestao_lida")],
            "anexos_com_problema": [a for m in membros for a in (m.get("anexos") or [])
                                    if a.get("escaneado") or a.get("erro")],
            # Todos os anexos lidos, para a tela de detalhe. Sem repetir: o
            # orgao reenvia o mesmo documento e cada reenvio traz o arquivo de
            # novo — quatro linhas iguais nao informam nada.
            "anexos": list({(a.get("arquivo"), a.get("familia")): a
                            for m in membros for a in (m.get("anexos") or [])}.values()),
            "emails": [{
                "id": m["id"], "chave": m["chave"], "recebido_em": m.get("recebido_em"),
                "assunto": m.get("assunto"), "corpo": m.get("corpo"), "pasta": m.get("pasta"),
                "situacao": m.get("situacao"), "observacao": m.get("observacao"),
                "em_tratativa": m.get("em_tratativa"),
                "entry_id": m.get("entry_id"),
                "anexos": m.get("anexos") or [],
                "itens": m.get("itens") or [],
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
    if not (chave.startswith("NE:") or chave.startswith("DOC")):
        raise HTTPException(400, "chave de grupo inválida: %s" % chave)
    # Os campos de que a chave depende vêm junto mesmo quando o chamador não
    # pediu: é por eles que se filtra.
    extras = "empenhos, chave, anexos, assunto, cnpj_orgao"
    pedido = colunas if colunas == "*" else "%s, %s" % (colunas, extras)
    todos = db.table("licitacao_entrada").select(pedido).eq("ativo", True)\
        .limit(5000).execute().data
    # Reagrupa tudo e devolve o grupo pedido: a mesma funcao da listagem, para
    # triar um card nunca afetar um conjunto diferente do que a tela mostrou.
    return agrupar(todos).get(chave, [])


def triar(entrada_id: str, usuario: UsuarioOut, situacao: Optional[str] = None,
          observacao: Optional[str] = None, cliente_id: Optional[str] = None,
          em_tratativa: Optional[bool] = None) -> dict:
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
    if observacao is not None and observacao.strip():
        # Nota ACUMULA. A versao anterior gravava numa coluna de texto so e
        # apagava a anterior em silencio — num caso que fica 30 dias aberto e
        # passa por mais de uma pessoa, o historico e o que explica por que ele
        # esta parado.
        db.table("licitacao_entrada_notas").insert({
            "entrada_id": entrada_id,
            "texto": observacao.strip(),
            "autor_id": str(usuario.id),
        }).execute()
    if cliente_id is not None:
        campos["cliente_id"] = cliente_id
    if em_tratativa is not None:
        campos["em_tratativa"] = bool(em_tratativa)
        # Quem assumiu e quando. Ao desmarcar, limpa — senao fica parecendo que
        # alguem ainda esta com o caso.
        campos["tratativa_por"] = str(usuario.id) if em_tratativa else None
        campos["tratativa_em"] = _agora() if em_tratativa else None
    db.table("licitacao_entrada").update(campos).eq("id", entrada_id).execute()
    return db.table("licitacao_entrada").select("*").eq("id", entrada_id).execute().data[0]


def triar_grupo(chave: str, usuario: UsuarioOut, situacao: Optional[str] = None,
                observacao: Optional[str] = None, cliente_id: Optional[str] = None,
                em_tratativa: Optional[bool] = None) -> dict:
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
              em_tratativa=em_tratativa,
              observacao=observacao if pos == 0 else None)
    return {"chave": chave, "afetados": len(regs)}


def apagar_nota(nota_id: str, usuario: UsuarioOut) -> dict:
    """Apaga uma anotação.

    Existe porque a falta de retorno visual na tela fez o Tassio clicar em
    "salvar nota" três vezes, gravando a mesma anotação três vezes. Sem uma
    forma de apagar, o engano viraria permanente — e anotação repetida em cima
    de um caso é justamente o que atrapalha quem for ler depois.
    """
    db = get_service_db()
    if not db.table("licitacao_entrada_notas").select("id").eq("id", nota_id).execute().data:
        raise HTTPException(404, "anotação não encontrada")
    db.table("licitacao_entrada_notas").delete().eq("id", nota_id).execute()
    return {"apagada": nota_id}


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
        # O prazo do documento entra sozinho quando a tela nao informou: e o
        # compromisso que o orgao exige, e deixar a demanda nascer sem prazo foi
        # o que criou 63% de demandas em que "atrasado" nao pode ser medido.
        prazo=extra.get("prazo") or _entrega_prevista(regs),
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
    # As anotações vêm da tabela de notas (v37), não mais da coluna antiga.
    db = get_service_db()
    ids = [r["id"] for r in regs]
    escritas: list[str] = []
    for i in range(0, len(ids), 100):
        escritas += [n["texto"] for n in db.table("licitacao_entrada_notas")
                     .select("texto, criado_em").in_("entrada_id", ids[i:i + 100])
                     .execute().data]
    if escritas:
        partes.append("Triagem: %s" % " | ".join(escritas)[:240])
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

    # Demanda por tipo de solicitacao: e a leitura que diz QUE trabalho e este.
    # Venda direta, consignacao e comunicado de uso sao operacoes diferentes,
    # com esforco diferente — 50 comunicados de uso e 5 vendas diretas nao e o
    # mesmo mes que o contrario, ainda que o total de casos seja parecido.
    por_tipo = []
    for t in TIPOS_SOLICITACAO:
        do_tipo = [c for c in abertos if (c["tipo"] or "OUTRO") == t]
        if not do_tipo and t == "OUTRO":
            continue
        por_tipo.append({
            "tipo": t,
            "casos": len(do_tipo),
            "valor": round(sum(c["valor_total"] for c in do_tipo), 2),
            "criticos": sum(1 for c in do_tipo if c["prioridade"] <= 1),
            "mais_antigo": max((c["dias_parados"] for c in do_tipo), default=0),
        })

    resolvidos = [c for c in cards if c["situacao"] == "SIM"]
    return {
        "periodo_dias": dias,
        "emails_recebidos": len(regs),
        "casos": len(cards),
        "abertos": len(abertos),
        "resolvidos": len(resolvidos),
        "criticos": sum(1 for c in abertos if c["prioridade"] <= 1),
        "sem_cliente": sum(1 for c in abertos if not c["cliente_id"]),
        "em_tratativa": sum(1 for c in abertos if c.get("em_tratativa")),
        "parados_por_faixa": faixas,
        "mais_antigo_dias": max((c["dias_parados"] for c in abertos), default=0),
        "valor_parado": round(sum(c["valor_total"] for c in com_valor), 2),
        "cobertura": {
            "casos_com_valor": len(com_valor),
            "casos_abertos": len(abertos),
            "casos_sem_valor_lido": len(abertos) - len(com_valor),
        },
        "por_tipo": por_tipo,
        "por_cliente": ranking,
        "entrada_por_dia": [{"dia": d, "emails": n} for d, n in sorted(por_dia.items())],
        "demandas_por_etapa": por_etapa,
    }


# ── de onde vem cada número do painel ───────────────────────────────────────
# Um painel que o conselho acompanha precisa poder ser aberto. Numero que nao
# se explica vira discussao sobre o numero, e nao sobre o processo — e foi
# exatamente isso que aconteceu com o faturamento do app contra o D365.
#
# Cada metrica declara TRES coisas: o filtro que a produz, a frase que diz de
# onde o dado sai, e a conta. A tela mostra as tres junto com a lista de casos,
# entao a resposta a "de onde veio isso?" e sempre um clique.
TIPOS_SOLICITACAO = ("VENDA_DIRETA", "CONSIGNACAO", "COMUNICADO_USO", "AMOSTRA", "OUTRO")

_ORIGEM_COMUM = (
    "Cada caso é uma nota de empenho (ou um e-mail sem NE) da caixa de entrada "
    "`licitacao_entrada`, alimentada 2x/dia pelo motor que lê a caixa "
    "licitacao@msbbrasil.com pelo Outlook. Um caso agrupa todos os e-mails que "
    "citam a mesma NE."
)


def _explica(metrica: str, dias: int) -> dict:
    """Filtro, origem e conta de uma métrica do painel."""
    faixas = {
        "faixa:ate_2": ("Esperando até 2 dias", lambda c: c["dias_parados"] <= 2),
        "faixa:de_3_a_7": ("Esperando de 3 a 7 dias", lambda c: 3 <= c["dias_parados"] <= 7),
        "faixa:de_8_a_15": ("Esperando de 8 a 15 dias", lambda c: 8 <= c["dias_parados"] <= 15),
        "faixa:mais_de_15": ("Esperando mais de 15 dias", lambda c: c["dias_parados"] > 15),
    }
    if metrica in faixas:
        titulo, teste = faixas[metrica]
        return {
            "titulo": titulo,
            "filtro": lambda c: c["situacao"] != "SIM" and teste(c),
            "origem": _ORIGEM_COMUM + " A espera é contada do PRIMEIRO e-mail do "
                      "caso até hoje, no fuso de Brasília — um pedido cobrado três "
                      "vezes está parado desde a primeira cobrança, não desde a última.",
            "conta": "Contagem de casos em aberto na faixa.",
        }

    if metrica.startswith("tipo:"):
        tipo = metrica[5:]
        return {
            "titulo": "Solicitações do tipo %s" % tipo.replace("_", " ").lower(),
            "filtro": lambda c: c["situacao"] != "SIM" and (c["tipo"] or "OUTRO") == tipo,
            "origem": _ORIGEM_COMUM + " O tipo é classificado pelo motor a partir do "
                      "assunto e do corpo do e-mail. Quando o e-mail não deixa claro, "
                      "fica como 'a classificar' — o motor não escolhe um tipo no "
                      "chute, porque isso faria a demanda nascer errada.",
            "conta": "Contagem de casos em aberto do tipo.",
        }

    if metrica.startswith("cliente:"):
        nome = metrica[8:]
        return {
            "titulo": "Casos de %s" % nome,
            "filtro": lambda c: c["situacao"] != "SIM" and (
                c["cliente_nome"] or c["orgao_texto"] or "(órgão não identificado)") == nome,
            "origem": _ORIGEM_COMUM + " O cliente vem, nesta ordem: do de-para de "
                      "órgãos (CNPJ lido no anexo), da demanda que já existia para "
                      "aquela NE, ou de alguém que escolheu à mão na triagem. Sem "
                      "nenhum dos três, aparece o nome do órgão como está no documento.",
            "conta": "Contagem e soma dos casos em aberto do cliente.",
        }

    registro = {
        "abertos": {
            "titulo": "Casos em aberto",
            "filtro": lambda c: c["situacao"] != "SIM",
            "origem": _ORIGEM_COMUM,
            "conta": "Casos cuja situação não é 'Resolvido'. Um caso só conta como "
                     "resolvido quando TODOS os e-mails dele estão resolvidos.",
        },
        "resolvidos": {
            "titulo": "Casos resolvidos",
            "filtro": lambda c: c["situacao"] == "SIM",
            "origem": _ORIGEM_COMUM + " A situação é marcada por gente, na triagem. "
                      "O motor nunca a altera.",
            "conta": "Casos em que todos os e-mails estão marcados como resolvidos.",
        },
        "criticos": {
            "titulo": "Casos críticos em aberto",
            "filtro": lambda c: c["situacao"] != "SIM" and c["prioridade"] <= 1,
            "origem": _ORIGEM_COMUM + " A prioridade é calculada pelo motor a partir "
                      "do assunto, do texto, do tipo e de quantos dias o caso está "
                      "parado. O caso herda a prioridade mais crítica entre seus e-mails.",
            "conta": "Casos em aberto com prioridade 1 (crítica).",
        },
        "sem_cliente": {
            "titulo": "Casos sem cliente definido",
            "filtro": lambda c: c["situacao"] != "SIM" and not c["cliente_id"],
            "origem": _ORIGEM_COMUM + " Sem cliente, o caso não pode virar demanda: "
                      "a demanda exige cliente, e adivinhar o errado é pior que travar.",
            "conta": "Casos em aberto em que nem o de-para nem a NE resolveram o cliente.",
        },
        "valor_parado": {
            "titulo": "Valor em aberto",
            "filtro": lambda c: c["situacao"] != "SIM" and c["valor_total"] > 0,
            "origem": "A soma sai dos ITENS extraídos do anexo do PEDIDO — nunca da "
                      "nota fiscal. O extrator só aceita um item quando a conta fecha "
                      "(quantidade × unitário = total) ou quando a coluna tem nome no "
                      "cabeçalho do documento; fora disso não emite nada.",
            "conta": "Soma de quantidade × valor unitário dos itens dos casos em "
                     "aberto. É um PISO, não o total: casos cujo anexo não rendeu "
                     "valor entram com zero.",
        },
        "mais_antigo": {
            "titulo": "O caso que espera há mais tempo",
            "filtro": lambda c: c["situacao"] != "SIM",
            "origem": _ORIGEM_COMUM,
            "conta": "Ordenado pela espera, do mais antigo para o mais recente.",
        },
    }
    if metrica not in registro:
        raise HTTPException(404, "não sei explicar a métrica '%s'" % metrica)
    return registro[metrica]


def detalhe(metrica: str, dias: int = 30) -> dict:
    """Os casos por trás de um número do painel, e de onde ele vem."""
    e = _explica(metrica, dias)
    casos = [c for c in listar(dias=dias) if e["filtro"](c)]
    if metrica == "mais_antigo":
        casos.sort(key=lambda c: -c["dias_parados"])
    return {
        "metrica": metrica,
        "titulo": e["titulo"],
        "origem": e["origem"],
        "conta": e["conta"],
        "periodo_dias": dias,
        "quantidade": len(casos),
        "valor": round(sum(c["valor_total"] for c in casos), 2),
        "casos": casos,
    }
