"""Linha comercial do produto (Uro / Vascular / Realclosure) — fonte única.

Antes existiam dois mapas família→linha hardcoded e divergentes
(`estoque_service` e `inteligencia_service`), o que deixava 12 SKUs fora das
análises por linha e obrigava a mexer no código a cada família nova.

Agora a ordem de resolução é:

1. `produtos.linha` — o que o comercial cadastra na tela de Cadastros. Fonte
   da verdade.
2. `FAMILIA_LINHA` — fallback por família, para código que não está na tabela
   `produtos`. Necessário porque o histórico de faturamento do D365 tem itens
   que nunca foram cadastrados (13 códigos, ~1% da receita) e famílias que só
   existem lá (CATETER REALCLOSURE, FIO GUIA LUNDERQUIST, etc).

Realclosure é linha à parte, não um subconjunto de Vascular: tem meta própria
em `metas_faturamento`.
"""
from typing import Optional

LINHAS = ("URO", "VASCULAR", "REALCLOSURE")

LINHA_LABEL = {"URO": "Urologia", "VASCULAR": "Vascular", "REALCLOSURE": "Realclosure"}

# Mapa unificado dos dois antigos + as famílias que só aparecem no export do
# D365. Serve de fallback e de semente para o backfill do campo produtos.linha.
FAMILIA_LINHA = {
    # ── Urologia ──────────────────────────────────────────────────────────────
    "BAINHA INTRODUTORA URETERAL": "URO",
    "DILATADOR URETERAL": "URO",
    "DUPLO J": "URO",
    "FIBRA LASER UROLOGIA": "URO",
    "FIO GUIA HIDROFILICO UROLOGICO": "URO",
    "IRRIGADOR URETERAL": "URO",
    "KIT DUPLO J": "URO",
    "SONDA BASKET": "URO",
    "SONDA URETERAL DUPLO J": "URO",
    "URETERESCOPIOS FLEXIVEIS": "URO",
    # ── Vascular ──────────────────────────────────────────────────────────────
    "BAINHA SPEED CROSS": "VASCULAR",
    "BAINHA SPEED CROSS TWIST": "VASCULAR",
    "CAMERA DE DRENAGEM": "VASCULAR",
    "CATETER ARTERIAL": "VASCULAR",
    "CATETER BALAO PTA": "VASCULAR",
    "CATETER DIAGNOSTICO": "VASCULAR",
    "CATETER EMBOLECTOMIA": "VASCULAR",
    "CATETER LACO SNARE": "VASCULAR",
    "DRENO DE TORAX": "VASCULAR",
    "ELETRODO TEMPORARIO": "VASCULAR",
    "FIO GUIA HIDROFILICO": "VASCULAR",
    "FIO GUIA LUNDERQUIST": "VASCULAR",
    "FIO GUIA TEFLONADO": "VASCULAR",
    "INSUFLADOR": "VASCULAR",
    "INTRODUTOR FEMORAL": "VASCULAR",
    "PIGTAIL CENTIMETRADO": "VASCULAR",
    "TUNELIZADOR": "VASCULAR",
    # ── Realclosure (linha própria, meta própria) ─────────────────────────────
    "REALCLOSURE": "REALCLOSURE",
    "CATETER REALCLOSURE": "REALCLOSURE",
}


def normalizar_familia(familia: Optional[str]) -> str:
    """Espaço duplo e caixa variam entre o cadastro e o export do D365."""
    return " ".join((familia or "").strip().upper().split())


def linha_da_familia(familia: Optional[str]) -> Optional[str]:
    return FAMILIA_LINHA.get(normalizar_familia(familia))


def mapa_por_codigo(db) -> dict:
    """codigo -> linha, a partir do cadastro de produtos (fonte da verdade).

    Tolera a coluna não existir: o deploy do código sobe antes da migration
    v28 rodar, e sem isso Estoque e Inteligência quebrariam nesse intervalo.
    Vazio = todo mundo cai no fallback por família, que é o comportamento
    anterior.
    """
    try:
        rows = db.table("produtos").select("codigo, linha").execute().data
    except Exception:
        return {}
    return {
        (r.get("codigo") or "").strip(): r["linha"]
        for r in rows
        if (r.get("codigo") or "").strip() and r.get("linha")
    }


def resolver(codigo: Optional[str], familia: Optional[str] = None,
             por_codigo: Optional[dict] = None) -> Optional[str]:
    """Linha do produto: cadastro primeiro, família como fallback.

    `por_codigo` vem de `mapa_por_codigo` — passe pronto para não consultar o
    banco a cada item numa lista grande.
    """
    if por_codigo:
        linha = por_codigo.get((codigo or "").strip())
        if linha:
            return linha
    return linha_da_familia(familia)


def label(linha: Optional[str]) -> str:
    return LINHA_LABEL.get(linha or "", "Outros")


# Canal legado embute a linha E se foi licitação ("LICITACAO_VASCULAR"). Para o
# rateio interessa só a linha.
_CANAL_LINHA = {
    "URO": "URO", "LICITACAO_URO": "URO",
    "VASCULAR": "VASCULAR", "LICITACAO_VASCULAR": "VASCULAR",
    "REALCLOSURE": "REALCLOSURE",
}


def linha_do_canal(canal: Optional[str]) -> Optional[str]:
    return _CANAL_LINHA.get((canal or "").strip().upper())


def ratear_por_linha(valor: float, itens: list, produtos: dict,
                     por_codigo: Optional[dict] = None,
                     canal: Optional[str] = None) -> dict:
    """Divide o valor de uma OV entre as linhas comerciais dos seus itens.

    `itens`: linhas de itens_pedido (produto_id, qtd_solicitada, valor_unitario)
    `produtos`: produto_id -> {codigo, familia}

    Uma OV pode ter itens de linhas diferentes — hoje ela conta inteira para um
    canal só, o que joga a venda para a meta errada. O rateio é pelo VALOR de
    cada item (qtd × preço), não pela quantidade: 1 cateter caro e 50 fios
    baratos não repartem meio a meio.

    Sem itens, ou com itens sem preço, cai no canal da OV — é o que existia
    antes e continua valendo enquanto o cadastro de itens não for completo.
    Devolve {} quando não dá para dizer nada, e quem chama decide o que fazer.
    """
    total = float(valor or 0)
    pesos: dict = {}
    for it in itens or []:
        p = produtos.get(it.get("produto_id")) or {}
        linha = resolver(p.get("codigo"), p.get("familia"), por_codigo)
        if not linha:
            continue
        peso = float(it.get("qtd_solicitada") or 0) * float(it.get("valor_unitario") or 0)
        if peso > 0:
            pesos[linha] = pesos.get(linha, 0.0) + peso

    if not pesos:
        # Sem preço nos itens, o rateio por valor não existe. Se todos os itens
        # são da mesma linha, ainda dá para afirmar a linha; senão, usa o canal.
        linhas = {resolver((produtos.get(it.get("produto_id")) or {}).get("codigo"),
                           (produtos.get(it.get("produto_id")) or {}).get("familia"), por_codigo)
                  for it in (itens or [])}
        linhas = {l for l in linhas if l}
        if len(linhas) == 1:
            return {next(iter(linhas)): round(total, 2)}
        fallback = linha_do_canal(canal)
        return {fallback: round(total, 2)} if fallback else {}

    soma = sum(pesos.values())
    saida = {l: round(total * (p / soma), 2) for l, p in pesos.items()}
    # Centavos da divisão vão para a maior linha, para o total fechar.
    dif = round(total - sum(saida.values()), 2)
    if dif and saida:
        maior = max(saida, key=lambda k: saida[k])
        saida[maior] = round(saida[maior] + dif, 2)
    return saida


def linha_predominante(itens: list, produtos: dict,
                       por_codigo: Optional[dict] = None) -> Optional[str]:
    """Linha de maior valor entre os itens — a "cara" da OV.

    Usada só para gravar `pedidos.canal` (histórico e rótulo de tela). A meta
    NÃO usa isto: ela usa `ratear_por_linha`, que divide a OV multi-linha em vez
    de escolher uma. Sem valor nos itens, cai na quantidade; sem nada, None.
    """
    rateio = ratear_por_linha(1.0, itens, produtos, por_codigo, None)
    if rateio:
        return max(rateio, key=lambda k: rateio[k])
    return None


def canal_legado(linha: Optional[str], forma_venda: Optional[str]) -> Optional[str]:
    """Monta o valor de `pedidos.canal` a partir das duas perguntas separadas.

    O canal continua gravado porque telas, filtros e o histórico o usam como
    rótulo. Agora ele é DERIVADO (linha dos itens + forma de venda), não
    digitado — é o que tira a chance de a venda ir para a meta errada.
    """
    if not linha:
        return None
    return f"LICITACAO_{linha}" if forma_venda == "LICITACAO" else linha
