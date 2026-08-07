"""Preenche pedidos.data_faturamento nas OVs faturadas antes da v31.

A data vem da movimentação de FATURADO que emitiu a NF que a OV tem HOJE — a
observação dessas movimentações é "NF <numero> emitida" / "Devolução registrada —
NF <numero>" / "Comunicado de uso ... NF <numero>". Casando o número, a competência
sai do histórico de forma auditável, em vez de heurística.

Quando nenhuma movimentação cita a NF atual, cai na PRIMEIRA de FATURADO — que é
exatamente o comportamento anterior, então essas OVs não mudam de mês.

Sem --aplicar apenas mostra, destacando quem mudaria de mês.

    python backfill_data_faturamento.py
    python backfill_data_faturamento.py --aplicar
"""
import os
import re
import sys
from collections import defaultdict

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
load_dotenv()

from app.core.database import get_service_db  # noqa: E402

APLICAR = "--aplicar" in sys.argv


def _nfs_da_observacao(obs: str) -> set:
    """Todos os números de NF citados, sem zeros à esquerda."""
    return {n.lstrip("0") for n in re.findall(r"NF\s*0*(\d+)", obs or "")}


def main() -> None:
    db = get_service_db()

    try:
        db.table("pedidos").select("id, data_faturamento").limit(1).execute()
    except Exception:
        print("A coluna data_faturamento nao existe. Rode a migration v31 primeiro:")
        print("  database/migracao_data_faturamento_v31.sql")
        sys.exit(1)

    peds = db.table("pedidos").select(
        "id, numero_pedido, numero_nf, valor_nf, valor_produtos, valor_frete, "
        "tipo_operacao, status, data_faturamento").neq("status", "CANCELADO").execute().data
    com_nf = [p for p in peds if (p.get("numero_nf") or "").strip()]
    print(f"OVs nao canceladas com NF: {len(com_nf)}")
    ja = [p for p in com_nf if p.get("data_faturamento")]
    print(f"  ja com data_faturamento: {len(ja)}")

    alvos = [p for p in com_nf if not p.get("data_faturamento")]
    print(f"  a preencher: {len(alvos)}")
    if not alvos:
        print("nada a fazer")
        return

    ids = [p["id"] for p in alvos]
    movs = []
    for i in range(0, len(ids), 40):
        movs += db.table("movimentacoes").select("pedido_id, criado_em, observacao")\
            .eq("status_novo", "FATURADO").in_("pedido_id", ids[i:i + 40]).execute().data
    por_ped = defaultdict(list)
    for m in movs:
        por_ped[m["pedido_id"]].append(m)

    resolvidos, por_fallback, sem_mov, mudam_mes = [], [], [], []
    for p in alvos:
        lst = sorted(por_ped.get(p["id"]) or [], key=lambda m: m["criado_em"] or "")
        if not lst:
            sem_mov.append(p)
            continue
        nf = (p.get("numero_nf") or "").strip().lstrip("0")
        casaram = [m for m in lst if nf and nf in _nfs_da_observacao(m.get("observacao"))]
        escolhida = (casaram or lst)[0]["criado_em"]
        antes = lst[0]["criado_em"]
        resolvidos.append((p, escolhida))
        if not casaram:
            por_fallback.append(p)
        if antes and escolhida and antes[:7] != escolhida[:7]:
            mudam_mes.append((p, antes, escolhida))

    print(f"\n  data vinda da NF atual:      {len(resolvidos) - len(por_fallback)}")
    print(f"  fallback (1a de FATURADO):   {len(por_fallback)}")
    print(f"  sem movimentacao de FATURADO:{len(sem_mov)}")

    def face(p):
        pr = float(p.get("valor_produtos") or 0)
        return pr if pr else float(p.get("valor_nf") or 0) - float(p.get("valor_frete") or 0)

    print(f"\n=== MUDAM DE MES: {len(mudam_mes)} ===")
    for p, a, n in sorted(mudam_mes, key=lambda x: x[1] or ""):
        print(f"  {p['numero_pedido']:<12} NF {str(p.get('numero_nf')):<8} "
              f"{a[:10]} -> {n[:10]}  R$ {face(p):>12,.2f}  {p.get('tipo_operacao')}")

    liq = defaultdict(float)
    for p, a, n in mudam_mes:
        if p.get("tipo_operacao") in ("VENDA_NORMAL", "COMUNICADO_USO", "DEVOLUCAO"):
            liq[a[:7]] -= face(p)
            liq[n[:7]] += face(p)
    if liq:
        print("\n  efeito por mes:")
        for mes in sorted(liq):
            print(f"    {mes}  R$ {liq[mes]:+,.2f}")

    if not APLICAR:
        print("\nSIMULACAO — rode com --aplicar para gravar.")
        return

    n = 0
    for p, quando in resolvidos:
        db.table("pedidos").update({"data_faturamento": quando}).eq("id", p["id"]).execute()
        n += 1
    print(f"\nAPLICADO: {n} OVs com data_faturamento preenchida.")
    if sem_mov:
        print(f"  {len(sem_mov)} sem movimentacao de FATURADO ficaram sem data "
              f"(seguem no fallback): " + ", ".join(p["numero_pedido"] for p in sem_mov[:10]))


if __name__ == "__main__":
    main()
