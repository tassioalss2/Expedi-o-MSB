"""Estoque disponível: foto do PCP de manhã, descontando as OVs do nosso app.

O PCP atualiza o estoque uma vez ao dia (planilha do D365 -> app deles). O nosso
app precisa mostrar o estoque ao longo do dia, então:

    disponível = foto do PCP (manhã) − comprometido pelas OVs

E o comprometido é sempre RECALCULADO das OVs reais, nunca decrementado num
saldo guardado. Saldo mutável acumula desvio e não dá para auditar; recalculando,
o número se autocorrige e a foto da manhã seguinte zera qualquer resíduo.

Quais OVs contam como comprometido
----------------------------------
Descoberto cruzando 3.836 OVs com saída física do D365 contra os status daqui: o
D365 baixa o estoque no FATURAMENTO (antes disso o material continua fisicamente
no estoque; LIBERADO/EM_COTACAO_FRETE apareceram com 0 baixas, EXPEDIDO com 249).

Então conta como comprometido toda OV não cancelada que:
  a) ainda não faturou — o material está na foto do PCP e já tem dono; ou
  b) faturou DEPOIS da foto — estava na foto de hoje e já saiu.

Sem o item (b) o número ficaria otimista durante o dia: material faturado hoje
saiu do estoque, mas a foto da manhã ainda o continha.

O que NÃO conta: OV cancelada, e OV que já havia faturado ANTES da foto — essa
o PCP já descontou, contar de novo seria baixa dupla.

E TAMBÉM não conta: OV JÁ LIBERADA antes da foto
-------------------------------------------------
Isto corrige a premissa acima. Liberar a OV faz o D365 gerar o trabalho de
separação, e o trabalho reserva o material — some da visão do PCP a partir da
foto seguinte, MESMO SEM FATURAR. A leitura antiga ("o D365 só baixa no
faturamento") vinha de cruzar saídas FÍSICAS, que de fato só ocorrem ao faturar;
o número que o PCP exporta, porém, já vem líquido de reserva.

Medido em 28/08/2026, com três OVs liberadas na véspera e não faturadas:

    UFGH-035150RHS   PA 1039 -> 735   (-304)   reservado nas OVs: 302
    55005            PA  461 -> 310   (-151)   reservado nas OVs: 150
    55004            PA  253 -> 192   ( -61)   reservado nas OVs:  60

Contar essas OVs de novo descontava duas vezes: 53030 chegou a exibir
disponível -26, quantidade fisicamente impossível e sintoma do erro.

A regra é a mesma já usada para o faturamento, aplicada à LIBERAÇÃO: conta quem
foi liberado DEPOIS da foto (a foto ainda tinha o material); não conta quem foi
liberado antes (a foto já veio sem ele).

Vale o status ATUAL, não o histórico: OV liberada que VOLTOU de etapa tem a
reserva desfeita no D365 e o material reaparece na foto — confirmado na OV016449,
que voltou para Ger. Crédito e cujas 50 un de USDJ-6026TK1 seguiam no PA do dia
seguinte.

PREMISSA: liberar no app corresponde a liberar no D365. Se alguém liberar aqui
sem liberar lá, o material será contado como disponível sem estar reservado de
fato — e aí a venda promete material que a separação não vai achar.
"""
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from app.core.database import get_service_db
from app.services import linha_produto, pcp_estoque_service

# Status em que o material ainda está fisicamente no estoque (o D365 só baixa no
# faturamento). BLOQUEADO entra: o material continua lá e segue reservado.
# AGUARD_DADOS_OV entra: é a OV que nasce da venda ganha no CRM ou da venda
# outbound, esperando só o número real do D365. O material já tem dono desde o
# instante do ganho. Estava de fora — 128 unidades vendidas apareciam como
# disponíveis para vender de novo, e a conferência de estoque da venda ficaria
# prometendo material já comprometido.
_STATUS_ABERTOS = [
    "AGUARD_DADOS_OV",
    "AGUARD_CREDITO", "LIBERADO", "EM_INVENTARIO", "AGUARD_VERIFICACAO",
    "DIVERGENCIA", "AGUARD_TRATATIVA", "EM_PROCESSO_SISTEMICO",
    "EM_COTACAO_FRETE", "AGUARD_TRANSPORTADORA", "AGUARD_FATURAMENTO",
    "BLOQUEADO",
]
# Já saiu do estoque físico.
_STATUS_FATURADOS = ["FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO"]

_FAIXA_CRITICO, _FAIXA_ATENCAO, _FAIXA_ADEQUADO, _FAIXA_ALTO = 1.0, 2.0, 6.0, 12.0

# A view do PCP (pa_coverage) não tem coluna "linha" — só família. A linha vem
# do cadastro do produto (produtos.linha), com fallback por família; ver
# app/services/linha_produto.py.
# `listar` devolve a linha já como rótulo ("Urologia"). Quem precisa comparar
# precisa da chave, e é aqui que ela volta.
_CHAVE_POR_LABEL = {v: k for k, v in linha_produto.LINHA_LABEL.items()}


def _linha_do_item(codigo, familia, por_codigo: dict) -> str:
    # Sem correspondência nem no cadastro nem no mapa de família: cai em
    # "Outros" em vez de sumir da lista.
    return linha_produto.label(linha_produto.resolver(codigo, familia, por_codigo))


def _hoje_brt() -> date:
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _status_cobertura(cobertura, consumo_medio: float) -> str:
    if consumo_medio <= 0 or cobertura is None:
        return "SEM_GIRO"
    if cobertura < _FAIXA_CRITICO:
        return "CRITICO"
    if cobertura < _FAIXA_ATENCAO:
        return "ATENCAO"
    if cobertura < _FAIXA_ADEQUADO:
        return "ADEQUADO"
    if cobertura < _FAIXA_ALTO:
        return "ALTO"
    return "EXCESSIVO"


# ── Sincronização da foto do PCP ────────────────────────────────────────────────

def _snapshot_do_dia(db, dia: date) -> list:
    try:
        return db.table("estoque_pcp_snapshot").select("*").eq("data_ref", dia.isoformat()).execute().data
    except Exception:
        # Tabela ainda não migrada (v19) — degrada sem quebrar a tela.
        return []


def _tem_coluna_historico(db) -> bool:
    """Se a v20 já rodou. Checado ANTES de inserir: descobrir pelo erro no meio
    dos lotes deixaria a foto do dia gravada pela metade."""
    try:
        db.table("estoque_pcp_snapshot").select("sales_history").limit(1).execute()
        return True
    except Exception:
        return False


def _inserir_snapshot(db, linhas: list) -> None:
    """Grava a foto. Sem a coluna sales_history (v20 não rodada) grava sem ela —
    o estoque é o essencial, o histórico do PCP é o extra."""
    if not _tem_coluna_historico(db):
        linhas = [{k: v for k, v in linha.items() if k != "sales_history"} for linha in linhas]
    for i in range(0, len(linhas), 200):
        db.table("estoque_pcp_snapshot").insert(linhas[i:i + 200]).execute()


def sincronizar(forcar: bool = False) -> dict:
    """Grava a foto do PCP do dia. Idempotente: se já existe foto de hoje e
    `forcar` é falso, não faz nada (a primeira abertura do dia sincroniza; o
    botão 'Sincronizar agora' passa forcar=True)."""
    db = get_service_db()
    dia = _hoje_brt()

    existente = _snapshot_do_dia(db, dia)
    if existente and not forcar:
        return {"sincronizou": False, "motivo": "ja_sincronizado_hoje",
                "itens": len(existente), "data_ref": dia.isoformat()}

    if not pcp_estoque_service.integracao_ativa():
        return {"sincronizou": False, "motivo": "integracao_desligada", "itens": 0,
                "data_ref": dia.isoformat()}

    dados = pcp_estoque_service.buscar_cobertura_pcp()
    if not dados:
        # PCP fora do ar: mantém a foto anterior em vez de gravar uma vazia.
        return {"sincronizou": False, "motivo": "pcp_indisponivel",
                "itens": len(existente), "data_ref": dia.isoformat()}

    agora = datetime.now(timezone.utc).isoformat()
    linhas = [{
        "data_ref": dia.isoformat(),
        "codigo": c["codigo"],
        "descricao": c.get("descricao"),
        "familia": c.get("familia"),
        "estoque_pa": c.get("estoque") or 0,
        "estoque_sa": c.get("estoque_sa") or 0,
        "estoque_total": c.get("estoque_total") or 0,
        "consumo_medio": c.get("consumo_medio") or 0,
        "cobertura_meses": c.get("cobertura_meses"),
        "sales_history": c.get("sales_history") or {},
        "sincronizado_em": agora,
    } for c in dados.values() if c.get("codigo")]

    try:
        if existente:
            # Re-sincronização do mesmo dia: troca a foto (unique data_ref+codigo).
            # Antes de trocar, olha o que mudou — depois do delete a foto anterior
            # não existe mais, e é a comparação que revela o SA que virou acabado.
            chegadas = _detectar_chegadas_sa(existente, linhas)
            if not chegadas and _foto_igual(existente, linhas):
                # Nada mudou: não reescreve 176 linhas à toa. Com sincronização
                # automática ao longo do dia isso é a maioria das rodadas.
                return {"sincronizou": False, "motivo": "sem_mudanca",
                        "itens": len(existente), "data_ref": dia.isoformat(),
                        "chegadas": []}
            db.table("estoque_pcp_snapshot").delete().eq("data_ref", dia.isoformat()).execute()
        else:
            chegadas = []
        _inserir_snapshot(db, linhas)
    except Exception:
        # Tabela ainda não migrada (v19).
        return {"sincronizou": False, "motivo": "tabela_ausente", "itens": 0,
                "data_ref": dia.isoformat()}

    if chegadas:
        _registrar_chegadas(db, dia, chegadas)
        _CACHE_EXIBICAO["dados"] = None  # o estoque mudou: a próxima leitura recalcula

    novos = _cadastrar_skus_novos(db, linhas)

    return {"sincronizou": True, "motivo": None, "itens": len(linhas),
            "data_ref": dia.isoformat(), "sincronizado_em": agora,
            "chegadas": chegadas, "skus_novos": novos}


def _cadastrar_skus_novos(db, linhas: list) -> list:
    """Cadastra em `produtos` os códigos que o PCP tem e o app ainda não.

    Sem isto um lançamento novo só existia no app quando alguém cadastrasse à
    mão — e até lá o item ficava invisível: a conferência de estoque da venda
    não acha o produto, e a OV não pode nem ser montada com ele.

    O PCP é a fonte do que existe de fato na fábrica, então ele é quem semeia o
    cadastro. Descrição e família vêm de lá; a linha comercial sai da família
    (Uro / Vascular / Realclosure). Se a família for nova e não estiver no mapa,
    o produto entra sem linha — melhor existir sem classificação do que não
    existir, e o comercial ajusta em Cadastros.

    Só INSERE. Nunca atualiza quem já existe: descrição e família são editadas
    na tela de Cadastros, e sobrescrever com o texto do PCP a cada 20 minutos
    apagaria essa curadoria.
    """
    try:
        existentes = {(p.get("codigo") or "").strip().upper()
                      for p in db.table("produtos").select("codigo").execute().data}
    except Exception:
        return []

    novos = []
    for l in linhas:
        cod = (l.get("codigo") or "").strip()
        if not cod or cod.upper() in existentes:
            continue
        existentes.add(cod.upper())   # o PCP pode repetir o código na mesma carga
        novos.append({
            "codigo": cod,
            "descricao": l.get("descricao"),
            "familia": l.get("familia"),
            "linha": linha_produto.linha_da_familia(l.get("familia")),
            "unidade": "UN",
            "ativo": True,
        })
    if not novos:
        return []

    try:
        db.table("produtos").insert(novos).execute()
    except Exception:
        # Não derruba a sincronização do estoque por causa do cadastro.
        return []
    return [{"codigo": n["codigo"], "descricao": n["descricao"],
             "familia": n["familia"], "linha": n["linha"]} for n in novos]


def _foto_igual(antiga: list, nova: list) -> bool:
    """Mesmos códigos com o mesmo PA e SA — nada a regravar."""
    def chave(linhas, campo_pa, campo_sa):
        return {(l.get("codigo") or "").strip().upper():
                (float(l.get(campo_pa) or 0), float(l.get(campo_sa) or 0)) for l in linhas}
    return chave(antiga, "estoque_pa", "estoque_sa") == chave(nova, "estoque_pa", "estoque_sa")


def _detectar_chegadas_sa(antiga: list, nova: list) -> list:
    """Itens em que o semiacabado virou acabado desde a foto anterior.

    A assinatura da chegada é o SA cair e o PA subir no mesmo código. Só isso —
    PA subindo sozinho é compra ou devolução, e SA caindo sozinho é baixa de
    produção que não entrou aqui; nenhum dos dois é "o material chegou".

    A quantidade creditada é o MENOR dos dois movimentos: se o PA subiu mais do
    que o SA caiu, a diferença veio de outro lugar e não é conversão.
    """
    por_cod = {(l.get("codigo") or "").strip().upper(): l for l in antiga}
    chegadas = []
    for l in nova:
        cod = (l.get("codigo") or "").strip().upper()
        ant = por_cod.get(cod)
        if not ant:
            continue
        pa_antes, sa_antes = float(ant.get("estoque_pa") or 0), float(ant.get("estoque_sa") or 0)
        pa_depois, sa_depois = float(l.get("estoque_pa") or 0), float(l.get("estoque_sa") or 0)
        subiu_pa = pa_depois - pa_antes
        caiu_sa = sa_antes - sa_depois
        if subiu_pa > 0 and caiu_sa > 0:
            chegadas.append({
                "codigo": l.get("codigo"),
                "descricao": l.get("descricao"),
                "qtd": round(min(subiu_pa, caiu_sa), 3),
                "pa_antes": pa_antes, "pa_depois": pa_depois,
                "sa_antes": sa_antes, "sa_depois": sa_depois,
            })
    return chegadas


def _registrar_chegadas(db, dia: date, chegadas: list) -> None:
    """Grava o log da chegada. Best-effort: se a migration v12 ainda não rodou, a
    sincronização segue valendo — só o aviso 'chegou agora' fica de fora."""
    try:
        db.table("estoque_chegadas_sa").insert([{
            "data_ref": dia.isoformat(), **c} for c in chegadas]).execute()
    except Exception:
        pass


def chegadas_do_dia(dia: Optional[date] = None) -> list:
    """O que virou acabado hoje, agrupado por código (várias rodadas somam)."""
    db = get_service_db()
    d = dia or _hoje_brt()
    try:
        linhas = db.table("estoque_chegadas_sa").select("*")\
            .eq("data_ref", d.isoformat()).order("detectado_em").execute().data
    except Exception:
        return []
    por_cod: dict = {}
    for l in linhas:
        cod = (l.get("codigo") or "").strip().upper()
        atual = por_cod.setdefault(cod, {"codigo": l.get("codigo"), "descricao": l.get("descricao"),
                                         "qtd": 0.0, "ultima": None})
        atual["qtd"] += float(l.get("qtd") or 0)
        atual["ultima"] = l.get("detectado_em")
    return sorted(por_cod.values(), key=lambda x: -x["qtd"])


# ── Comprometido pelas OVs ──────────────────────────────────────────────────────

def _ts_para_filtro(momento: str) -> str:
    """Timestamp em formato seguro para a query string. O offset '+00:00' quebra
    o filtro (o '+' não é escapado e o PostgREST lê como espaço), então usa 'Z'."""
    if not momento:
        return ""
    try:
        dt = datetime.fromisoformat(momento.replace("Z", "+00:00"))
    except Exception:
        return momento.split("+")[0]
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + "Z"


def _ovs_faturadas_apos(db, momento: str) -> list:
    """pedido_ids que passaram para FATURADO depois da foto — estavam nela e já
    saíram, então ainda contam como baixa do dia."""
    filtro = _ts_para_filtro(momento)
    if not filtro:
        return []
    movs = db.table("movimentacoes").select("pedido_id, criado_em")\
        .eq("status_novo", "FATURADO").gte("criado_em", filtro).execute().data
    return list({m["pedido_id"] for m in movs if m.get("pedido_id")})


# ── Ajuste manual ─────────────────────────────────────────────────────────────
#
# A divergência é real: o PCP fotografa de manhã, o material chega durante o dia,
# e a OV não pode ficar parada esperando a foto de amanhã.
#
# O ajuste corrige a FOTO, não guarda um saldo — a conta continua sendo
# "PA (corrigido) menos comprometido", que é o que mantém o número auditável. E
# vale só para a foto daquele dia: quando o PCP manda a próxima, o ajuste sai de
# cena sozinho, para a correção de hoje não virar mentira permanente.

def _ajustes_do_dia(db, dia: date) -> dict:
    """codigo -> ajuste vigente (o mais recente do dia). Tolera a tabela não
    existir: sem a migration v15 o app segue com a foto crua do PCP."""
    try:
        rows = db.table("estoque_ajustes")\
            .select("codigo, estoque_pa, pa_anterior, motivo, usuario_id, criado_em")\
            .eq("data_ref", dia.isoformat()).order("criado_em").execute().data
    except Exception:
        return {}
    # Ordem crescente + sobrescrita = o último do dia vence.
    return {(r.get("codigo") or "").strip().upper(): r for r in rows}


def ajustar(codigo: str, estoque_pa: float, motivo: str, usuario_id: str) -> dict:
    """Corrige o PA da foto de hoje para um código, com motivo obrigatório.

    Não mexe em `estoque_pcp_snapshot`: a foto do PCP fica intacta, e o ajuste é
    uma camada por cima. Assim dá para ver lado a lado o que o PCP disse e o que
    foi conferido na prateleira.
    """
    cod = (codigo or "").strip().upper()
    if not cod:
        raise ValueError("Informe o código do item.")
    if not (motivo or "").strip():
        raise ValueError("Informe o motivo do ajuste — ajuste sem motivo não se audita.")
    qtd = float(estoque_pa)
    if qtd < 0:
        raise ValueError("A quantidade em estoque não pode ser negativa.")

    db = get_service_db()
    dia = _hoje_brt()
    snap = db.table("estoque_pcp_snapshot").select("codigo, estoque_pa")\
        .eq("data_ref", dia.isoformat()).ilike("codigo", cod).execute().data
    if not snap:
        # Sem foto de hoje para o código: aceita mesmo assim. É justamente o caso
        # do SKU novo que o PCP ainda não fotografou, e travar aqui deixaria a OV
        # parada por falta de dado nosso.
        anterior = None
    else:
        anterior = float(snap[0].get("estoque_pa") or 0)

    linha = {
        "codigo": cod,
        "data_ref": dia.isoformat(),
        "estoque_pa": qtd,
        "pa_anterior": anterior,
        "motivo": motivo.strip(),
        "usuario_id": usuario_id,
    }
    novo = db.table("estoque_ajustes").insert(linha).execute().data[0]
    # A tela de estoque lê do cache de exibição; sem invalidar, o ajuste só
    # apareceria dois minutos depois — e quem ajustou acharia que não funcionou.
    _CACHE_EXIBICAO["dados"] = None
    return novo


def ajustes_do_codigo(codigo: str, limite: int = 20) -> list:
    """Histórico de ajustes de um código, do mais recente para o mais antigo."""
    db = get_service_db()
    try:
        return db.table("estoque_ajustes")\
            .select("codigo, data_ref, estoque_pa, pa_anterior, motivo, usuario_id, criado_em")\
            .ilike("codigo", (codigo or "").strip().upper())\
            .order("criado_em", desc=True).limit(limite).execute().data
    except Exception:
        return []


# Etapas em que a OV já foi liberada para separação — é a liberação que faz o
# D365 criar o trabalho e reservar o material.
_STATUS_POS_LIBERACAO = [
    "LIBERADO", "EM_INVENTARIO", "AGUARD_VERIFICACAO", "DIVERGENCIA",
    "AGUARD_TRATATIVA", "EM_PROCESSO_SISTEMICO", "EM_COTACAO_FRETE",
    "AGUARD_TRANSPORTADORA", "AGUARD_FATURAMENTO",
]


def _ovs_reservadas_na_foto(db, sincronizado_em: Optional[str]) -> set:
    """OVs cuja reserva no D365 JÁ está descontada na foto do PCP.

    São as que estão AGORA em etapa pós-liberação e entraram nela ANTES da foto.
    Contá-las de novo no comprometido é baixa dupla (ver docstring do módulo).

    Status atual e não histórico: OV que voltou de etapa tem a reserva desfeita e
    o material volta para a foto — ela precisa voltar a contar.
    """
    if not sincronizado_em:
        return set()

    atuais = []
    for i in range(0, len(_STATUS_POS_LIBERACAO), 10):
        lote = _STATUS_POS_LIBERACAO[i:i + 10]
        atuais += db.table("pedidos").select("id").in_("status", lote).execute().data
    ids = [p["id"] for p in atuais]
    if not ids:
        return set()

    # Quando cada uma entrou em etapa pós-liberação (a primeira vez).
    entrada: dict = {}
    for i in range(0, len(ids), 40):
        for m in db.table("movimentacoes").select("pedido_id, status_novo, criado_em")\
                .in_("pedido_id", ids[i:i + 40]).execute().data:
            if m.get("status_novo") in _STATUS_POS_LIBERACAO:
                k = m["pedido_id"]
                quando = m.get("criado_em") or ""
                if k not in entrada or quando < entrada[k]:
                    entrada[k] = quando
    return {pid for pid, quando in entrada.items() if quando and quando < sincronizado_em}


def _comprometido_por_produto(db, sincronizado_em: str) -> dict:
    """produto_id -> qtd comprometida (ver regra no docstring do módulo)."""
    ids = set()
    for i in range(0, len(_STATUS_ABERTOS), 10):
        lote = _STATUS_ABERTOS[i:i + 10]
        for p in db.table("pedidos").select("id").in_("status", lote).execute().data:
            ids.add(p["id"])
    ids.update(_ovs_faturadas_apos(db, sincronizado_em))
    # Reserva do D365 já embutida na foto: descontar de novo é baixa dupla.
    ids -= _ovs_reservadas_na_foto(db, sincronizado_em)
    if not ids:
        return {}

    ids = list(ids)
    comprometido: dict = {}
    for i in range(0, len(ids), 40):
        itens = db.table("itens_pedido").select("produto_id, qtd_solicitada")\
            .in_("pedido_id", ids[i:i + 40]).execute().data
        for it in itens:
            pid = it.get("produto_id")
            if pid:
                comprometido[pid] = comprometido.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)
    return comprometido


def _codigo_por_produto_id(db) -> dict:
    """produto_id -> codigo. O cruzamento com o PCP é pelo código do produto."""
    prods = db.table("produtos").select("id, codigo").execute().data
    return {p["id"]: (p.get("codigo") or "").strip().upper() for p in prods if p.get("codigo")}


def comprometido_detalhe(codigo: str) -> dict:
    """As OVs por trás do número de 'comprometido' de um código — para o usuário
    clicar e ver de onde vem, em vez de confiar cegamente na conta."""
    db = get_service_db()
    cod = (codigo or "").strip().upper()

    produtos = db.table("produtos").select("id").ilike("codigo", cod).execute().data
    produto_ids = [p["id"] for p in produtos]
    if not produto_ids:
        return {"codigo": codigo, "ovs": []}

    dia = _hoje_brt()
    snapshot = _snapshot_do_dia(db, dia)
    if not snapshot:
        ultimas = db.table("estoque_pcp_snapshot").select("data_ref")\
            .order("data_ref", desc=True).limit(1).execute().data
        if ultimas:
            snapshot = _snapshot_do_dia(db, date.fromisoformat(ultimas[0]["data_ref"]))
    sincronizado_em = snapshot[0].get("sincronizado_em") if snapshot else None

    ids_abertos = set()
    for i in range(0, len(_STATUS_ABERTOS), 10):
        lote = _STATUS_ABERTOS[i:i + 10]
        for p in db.table("pedidos").select("id").in_("status", lote).execute().data:
            ids_abertos.add(p["id"])
    ids_faturados_depois = set(_ovs_faturadas_apos(db, sincronizado_em))
    # Mesma exclusão do cálculo — senão o detalhe somaria diferente do número.
    ids_na_foto = _ovs_reservadas_na_foto(db, sincronizado_em)
    ids_relevantes = (ids_abertos | ids_faturados_depois) - ids_na_foto
    if not ids_relevantes:
        return {"codigo": codigo, "ovs": []}

    itens = []
    for i in range(0, len(produto_ids), 40):
        lote = produto_ids[i:i + 40]
        itens += db.table("itens_pedido").select("pedido_id, qtd_solicitada")\
            .in_("produto_id", lote).execute().data
    pedido_ids = [it["pedido_id"] for it in itens if it.get("pedido_id") in ids_relevantes]
    if not pedido_ids:
        return {"codigo": codigo, "ovs": []}

    qtd_por_pedido: dict = {}
    for it in itens:
        pid = it.get("pedido_id")
        if pid in ids_relevantes:
            qtd_por_pedido[pid] = qtd_por_pedido.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)

    pedidos = []
    for i in range(0, len(pedido_ids), 40):
        pedidos += db.table("pedidos").select("id, numero_pedido, status, cliente_id, criado_em")\
            .in_("id", pedido_ids[i:i + 40]).execute().data
    cliente_ids = list({p["cliente_id"] for p in pedidos if p.get("cliente_id")})
    clientes = {}
    for i in range(0, len(cliente_ids), 40):
        for c in db.table("clientes").select("id, nome").in_("id", cliente_ids[i:i + 40]).execute().data:
            clientes[c["id"]] = c.get("nome")

    ovs = [{
        "pedido_id": p["id"],
        "numero_pedido": p.get("numero_pedido"),
        "status": p.get("status"),
        "cliente": clientes.get(p.get("cliente_id")),
        "qtd": round(qtd_por_pedido.get(p["id"], 0.0)),
        "criado_em": p.get("criado_em"),
        "faturada_depois_da_foto": p.get("status") not in _STATUS_ABERTOS,
        # OV que já faturou não tem reserva a liberar: o material saiu de fato.
        # A tela usa isto para não oferecer a ação onde ela seria recusada.
        "pode_liberar": p.get("status") in _STATUS_ABERTOS,
    } for p in pedidos]
    ovs.sort(key=lambda o: o["criado_em"] or "", reverse=True)
    return {"codigo": codigo, "ovs": ovs}


# ── Histórico de vendas e tendência ─────────────────────────────────────────────
#
# O histórico mensal vem do PCP (pa_products.sales_history, do D365) porque tem
# 6 meses fechados — o nosso app só existe desde 29/05/2026. A tendência compara
# os 3 últimos meses fechados com os 3 anteriores, que é o mesmo período da média
# de consumo e amortece a variação mês a mês (compra de licitação num mês só).
#
# O mês CORRENTE não está no histórico do PCP (eles importam mês fechado), então
# o acumulado do mês em curso é calculado das OVs faturadas daqui — é a fonte que
# sabe o que aconteceu hoje. Nunca soma as duas: o PCP cobre meses fechados, o
# app cobre o mês em curso.


def _meses_ate(fim_mes: str, quantidade: int) -> list:
    """['AAAA-MM', ...] terminando em fim_mes (inclusive), do mais antigo ao mais
    recente."""
    ano, mes = int(fim_mes[:4]), int(fim_mes[5:7])
    chaves = []
    for _ in range(quantidade):
        chaves.append(f"{ano:04d}-{mes:02d}")
        mes -= 1
        if mes < 1:
            mes = 12
            ano -= 1
    return list(reversed(chaves))


def _mes_anterior(mes_ref: str) -> str:
    ano, mes = int(mes_ref[:4]), int(mes_ref[5:7])
    mes -= 1
    if mes < 1:
        mes, ano = 12, ano - 1
    return f"{ano:04d}-{mes:02d}"


def _tendencia_do_historico(historico: dict, ultimo_mes: str) -> tuple:
    """Compara os 3 meses fechados até ultimo_mes com os 3 anteriores. Devolve
    (media_recente, media_anterior, pct). pct é None sem base de comparação —
    item novo ou parado, onde qualquer percentual seria invenção."""
    if not historico:
        return None, None, None
    recentes = _meses_ate(ultimo_mes, 3)
    anteriores = _meses_ate(_meses_ate(ultimo_mes, 3)[0], 4)[:3]

    def media(chaves):
        # Mês ausente no histórico = sem venda no mês, conta como zero: o PCP só
        # inclui a chave quando houve movimento.
        return sum(float(historico.get(k) or 0) for k in chaves) / len(chaves)

    m_rec, m_ant = media(recentes), media(anteriores)
    if m_ant <= 0:
        return round(m_rec, 1), round(m_ant, 1), None
    return round(m_rec, 1), round(m_ant, 1), round((m_rec - m_ant) / m_ant * 100)


def _ultimo_mes_fechado(historicos: list) -> str:
    """O mês FECHADO mais recente do histórico do PCP.

    Vem do dado em vez de ser calculado do calendário: se eles atrasarem a
    importação, a tendência acompanha o que existe em vez de comparar contra
    meses vazios. Mas nunca passa do mês anterior — o PCP manda o mês corrente
    parcial no sales_history, e incluir 5 dias de agosto como se fossem um mês
    inteiro derrubava a média recente e chegava a inverter o sinal da
    tendência (item estável aparecendo com -30%)."""
    limite = _mes_anterior(_hoje_brt().strftime("%Y-%m"))
    chaves = {k for h in historicos if h for k in h if k <= limite}
    if chaves:
        return max(chaves)
    return limite


def _vendido_no_mes_por_codigo(db, mes_ref: str) -> dict:
    """codigo -> qtd faturada no mês corrente, das OVs daqui. Mesmo corte do
    comprometido: conta pela data em que a OV virou FATURADO."""
    inicio = datetime(int(mes_ref[:4]), int(mes_ref[5:7]), 1, tzinfo=timezone.utc)
    movs = db.table("movimentacoes").select("pedido_id, criado_em")        .eq("status_novo", "FATURADO").gte("criado_em", _ts_para_filtro(inicio.isoformat())).execute().data
    # Uma OV pode ter várias movimentações para FATURADO (correção de status);
    # a primeira é a que marca a saída.
    data_por_pedido: dict = {}
    for m in movs:
        pid, d = m.get("pedido_id"), m.get("criado_em")
        if pid and d and (pid not in data_por_pedido or d < data_por_pedido[pid]):
            data_por_pedido[pid] = d
    if not data_por_pedido:
        return {}

    pedido_ids = list(data_por_pedido.keys())
    itens = []
    for i in range(0, len(pedido_ids), 40):
        itens += db.table("itens_pedido").select("pedido_id, produto_id, qtd_solicitada")            .in_("pedido_id", pedido_ids[i:i + 40]).execute().data

    cod_por_pid = _codigo_por_produto_id(db)
    out: dict = {}
    for it in itens:
        cod = cod_por_pid.get(it.get("produto_id"))
        if cod and it.get("pedido_id") in data_por_pedido:
            out[cod] = out.get(cod, 0.0) + float(it.get("qtd_solicitada") or 0)
    return out


def historico_vendas(codigo: str) -> dict:
    """Histórico mensal do PCP (6 meses fechados) + o acumulado do mês corrente
    calculado das OVs daqui, para o modal do item."""
    db = get_service_db()
    cod = (codigo or "").strip().upper()

    mes_atual = _hoje_brt().strftime("%Y-%m")
    vazio = {"codigo": codigo, "descricao": None, "meses": [], "total_fechado": 0,
             "consumo_medio": None, "cobertura_atual": None, "tendencia_pct": None,
             "media_3m": None, "media_3m_anterior": None,
             "vendido_mes_atual": 0, "mes_atual": mes_atual}

    dia = _hoje_brt()
    snapshot = _snapshot_do_dia(db, dia)
    if not snapshot:
        try:
            ultimas = db.table("estoque_pcp_snapshot").select("data_ref")\
                .order("data_ref", desc=True).limit(1).execute().data
        except Exception:
            ultimas = []
        if not ultimas:
            return vazio
        snapshot = _snapshot_do_dia(db, date.fromisoformat(ultimas[0]["data_ref"]))

    row = next((r for r in snapshot if (r.get("codigo") or "").strip().upper() == cod), None)
    if not row:
        return vazio

    historico = row.get("sales_history") or {}
    ultimo_fechado = _ultimo_mes_fechado([r.get("sales_history") for r in snapshot])
    meses = [{"mes": k, "qtd": round(float(historico.get(k) or 0))} for k in _meses_ate(ultimo_fechado, 6)]
    media_3m, media_3m_ant, tendencia_pct = _tendencia_do_historico(historico, ultimo_fechado)

    consumo = float(row.get("consumo_medio") or 0)
    comprometido = _comprometido_por_produto(db, row.get("sincronizado_em"))
    cod_por_pid = _codigo_por_produto_id(db)
    comp = sum(q for pid, q in comprometido.items() if cod_por_pid.get(pid) == cod)
    disponivel = float(row.get("estoque_pa") or 0) - comp
    sa = float(row.get("estoque_sa") or 0)

    return {
        "codigo": row.get("codigo"),
        "descricao": row.get("descricao"),
        "meses": meses,
        "total_fechado": round(sum(m["qtd"] for m in meses)),
        "consumo_medio": round(consumo, 1),
        "cobertura_atual": round((disponivel + sa) / consumo, 1) if consumo > 0 else None,
        "tendencia_pct": tendencia_pct,
        "media_3m": media_3m,
        "media_3m_anterior": media_3m_ant,
        "vendido_mes_atual": round(_vendido_no_mes_por_codigo(db, mes_atual).get(cod, 0.0)),
        "mes_atual": mes_atual,
    }


# ── Consulta ────────────────────────────────────────────────────────────────────

def disponivel_por_codigo() -> dict:
    """{codigo: {disponivel, estoque_sa, descricao, linha}} para o seletor de itens.

    Não sincroniza com o PCP: quem escolhe um produto numa lista não pode esperar
    um round trip. A foto da manhã com o comprometido descontado em tempo real já
    responde "tem ou não tem", e a decisão que VINCULA (o ganho da venda) refaz a
    conta com sincronização.
    """
    dados = listar(sincronizar_se_preciso=False)
    return {
        "itens": {
            (i.get("codigo") or "").strip().upper(): {
                "disponivel": i.get("disponivel"),
                "estoque_sa": i.get("estoque_sa"),
                "descricao": i.get("descricao"),
                # Linha comercial: o seletor mostra para qual meta o item conta,
                # inclusive nos itens já gravados de uma OV que está sendo editada.
                # Vai a CHAVE (URO/VASCULAR/...), não o rótulo: quem consome
                # compara com a chave, e o rótulo é decisão de exibição.
                "linha": _CHAVE_POR_LABEL.get(i.get("linha")),
                # Avisa que este número passou por ajuste manual hoje — quem
                # escolhe o item na OV precisa saber que não veio do PCP.
                "ajustado": bool(i.get("ajuste")),
            }
            for i in (dados.get("itens") or []) if i.get("codigo")
        },
        "data_ref": dados.get("data_ref"),
        "desatualizado": dados.get("desatualizado"),
    }


# Montar o estoque custa alguns segundos: o comprometido é recalculado varrendo
# as OVs abertas, e o vendido no mês, as faturadas. Vale a pena e não vai virar
# saldo guardado (ver o topo do módulo) — mas telas que só EXIBEM chamam isto a
# cada refetch, e a coluna de pendências do CRM recarrega a cada 30s.
#
# Então o caminho "só exibição" (sincronizar_se_preciso=False) reaproveita o
# último resultado por alguns segundos. Quem VINCULA decisão passa True, faz o
# round trip no PCP e nunca lê daqui.
# 2 min: a foto do PCP muda UMA VEZ AO DIA, e o que varia no meio do dia é o
# comprometido pelas OVs. Segurar por 2 minutos não muda decisão nenhuma, e é
# maior que o refetch de 30s da coluna — senão metade das chamadas pagaria tudo
# de novo.
_CACHE_EXIBICAO: dict = {"em": 0.0, "dados": None}
_CACHE_SEGUNDOS = 120


def listar(sincronizar_se_preciso: bool = True) -> dict:
    """Estoque disponível por item: foto do PCP menos o comprometido pelas OVs."""
    if not sincronizar_se_preciso:
        cache = _CACHE_EXIBICAO
        if cache["dados"] is not None and (time.monotonic() - cache["em"]) < _CACHE_SEGUNDOS:
            return cache["dados"]

    db = get_service_db()
    dia = _hoje_brt()

    sync = None
    if sincronizar_se_preciso:
        sync = sincronizar()

    snapshot = _snapshot_do_dia(db, dia)
    if not snapshot:
        # Sem foto de hoje (PCP fora do ar na 1ª abertura, ou integração
        # desligada): cai para a última foto disponível, sinalizando a data.
        try:
            ultimas = db.table("estoque_pcp_snapshot").select("data_ref")\
                .order("data_ref", desc=True).limit(1).execute().data
        except Exception:
            ultimas = []
        if not ultimas:
            return {"itens": [], "data_ref": None, "sincronizado_em": None,
                    "desatualizado": True, "sync": sync,
                    "integracao": pcp_estoque_service.integracao_ativa()}
        dia = date.fromisoformat(ultimas[0]["data_ref"])
        snapshot = _snapshot_do_dia(db, dia)

    sincronizado_em = snapshot[0].get("sincronizado_em") if snapshot else None
    comprometido_por_pid = _comprometido_por_produto(db, sincronizado_em)

    # Agrupa o comprometido por código (o snapshot é por código).
    cod_por_pid = _codigo_por_produto_id(db)
    comprometido_por_codigo: dict = {}
    for pid, qtd in comprometido_por_pid.items():
        cod = cod_por_pid.get(pid)
        if cod:
            comprometido_por_codigo[cod] = comprometido_por_codigo.get(cod, 0.0) + qtd

    # O que virou acabado hoje — a tela marca esses itens, porque é a mudança que
    # pode destravar uma venda parada.
    chegadas_por_codigo = {(c["codigo"] or "").strip().upper(): c
                           for c in chegadas_do_dia(dia)}

    ajustes = _ajustes_do_dia(db, dia)
    nomes_ajuste = {}
    if ajustes:
        ids = [a.get("usuario_id") for a in ajustes.values() if a.get("usuario_id")]
        if ids:
            try:
                for u in db.table("usuarios").select("id, nome").in_("id", list(set(ids))).execute().data:
                    nomes_ajuste[u["id"]] = u.get("nome")
            except Exception:
                pass

    mes_atual = _hoje_brt().strftime("%Y-%m")
    vendido_mes = _vendido_no_mes_por_codigo(db, mes_atual)
    ultimo_fechado = _ultimo_mes_fechado([row.get("sales_history") for row in snapshot])
    linha_por_codigo = linha_produto.mapa_por_codigo(db)

    itens = []
    for row in snapshot:
        cod = (row.get("codigo") or "").strip().upper()
        pa = float(row.get("estoque_pa") or 0)
        # Ajuste manual do dia substitui o PA da foto — a foto continua intacta no
        # snapshot, e as duas quantidades aparecem lado a lado na tela.
        aj = ajustes.get(cod)
        pa_pcp = pa
        if aj is not None:
            pa = float(aj.get("estoque_pa") or 0)
        sa = float(row.get("estoque_sa") or 0)
        comp = comprometido_por_codigo.get(cod, 0.0)
        # Pode ficar negativo: a foto é de manhã e mais OVs entraram do que havia
        # material. Mostrar negativo é o sinal, não um erro para esconder.
        disponivel = pa - comp
        consumo = float(row.get("consumo_medio") or 0)
        cobertura_pcp = row.get("cobertura_meses")
        cobertura_pcp = float(cobertura_pcp) if cobertura_pcp is not None else None
        # Cobertura do disponível (PA+SA já comprometidos descontados), que é a
        # que responde "por quanto tempo ainda dá conta".
        cob_disp = round((disponivel + sa) / consumo, 1) if consumo > 0 else None
        historico = row.get("sales_history") or {}
        media_3m, media_3m_ant, tendencia_pct = _tendencia_do_historico(historico, ultimo_fechado)
        itens.append({
            "codigo": row.get("codigo"),
            "descricao": row.get("descricao"),
            "familia": row.get("familia"),
            "linha": _linha_do_item(row.get("codigo"), row.get("familia"), linha_por_codigo),
            "estoque_pcp": round(pa),
            "estoque_sa": round(sa),
            "comprometido": round(comp),
            "disponivel": round(disponivel),
            "consumo_medio": round(consumo, 1),
            "cobertura_pcp": cobertura_pcp,
            "cobertura_disponivel": cob_disp,
            "status": _status_cobertura(cob_disp, consumo),
            "chegou_hoje": round(float((chegadas_por_codigo.get(cod) or {}).get("qtd") or 0), 3),
            "vendido_mes_atual": round(vendido_mes.get(cod, 0.0)),
            "tendencia_pct": tendencia_pct,
            "media_3m": media_3m,
            "media_3m_anterior": media_3m_ant,
            # Ajuste manual do dia, quando houver. A tela mostra o que o PCP
            # fotografou junto do que foi conferido — quem lê precisa saber que
            # aquele número não veio do PCP.
            "ajuste": None if aj is None else {
                "estoque_pa": round(float(aj.get("estoque_pa") or 0)),
                "pcp_dizia": None if aj.get("pa_anterior") is None else round(float(aj["pa_anterior"])),
                "motivo": aj.get("motivo"),
                "por": nomes_ajuste.get(aj.get("usuario_id")),
                "em": aj.get("criado_em"),
            },
            "estoque_pcp_original": round(pa_pcp),
        })

    itens.sort(key=lambda i: (i["cobertura_disponivel"] is None, i["cobertura_disponivel"] or 0))
    resultado = {
        "itens": itens,
        "data_ref": dia.isoformat(),
        "sincronizado_em": sincronizado_em,
        "desatualizado": dia != _hoje_brt(),
        "mes_atual": mes_atual,
        "ultimo_mes_fechado": ultimo_fechado,
        "sync": sync,
        "integracao": pcp_estoque_service.integracao_ativa(),
        # Resumo do dia para o cabeçalho: o que chegou desde a primeira foto.
        "chegadas_hoje": list(chegadas_por_codigo.values()),
    }
    # Guarda para as telas de exibição. Vale também o resultado vindo de uma
    # chamada com sincronização: ele é mais fresco ainda.
    _CACHE_EXIBICAO["dados"] = {**resultado, "sync": None}
    _CACHE_EXIBICAO["em"] = time.monotonic()
    return resultado
