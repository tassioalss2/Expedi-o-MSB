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
    """codigo -> linha, a partir do cadastro de produtos (fonte da verdade)."""
    rows = db.table("produtos").select("codigo, linha").execute().data
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
