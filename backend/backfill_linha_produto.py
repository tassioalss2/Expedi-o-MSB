"""Backfill de produtos.linha a partir do mapa por família (migration v28).

Roda depois de aplicar migracao_produto_linha_v28.sql. Idempotente: só preenche
quem está sem linha, então pode rodar de novo sem desfazer ajuste manual feito
na tela de Cadastros.

    python backfill_linha_produto.py           # mostra o que faria
    python backfill_linha_produto.py --aplicar # grava
"""
import sys
sys.path.insert(0, '.')
from app.core.database import get_service_db
from app.services import linha_produto

# Produtos sem família cadastrada, resolvidos pela descrição (kit de duplo J =
# urologia). Conferido item a item; sem isso ficariam em "Outros".
POR_CODIGO = {
    "52064": "URO",
    "USDJ-4712TK1": "URO",
}

APLICAR = "--aplicar" in sys.argv

db = get_service_db()
try:
    prods = db.table("produtos").select("id, codigo, descricao, familia, linha").execute().data
except Exception as exc:
    print("ERRO ao ler produtos.linha — a migration v28 ja foi aplicada?")
    print(f"  {exc}")
    sys.exit(1)

planejado, sem_resolver, ja_tem = [], [], 0
for p in prods:
    if p.get("linha"):
        ja_tem += 1
        continue
    cod = (p.get("codigo") or "").strip()
    alvo = POR_CODIGO.get(cod) or linha_produto.linha_da_familia(p.get("familia"))
    if alvo:
        planejado.append((p, alvo))
    else:
        sem_resolver.append(p)

print(f"produtos: {len(prods)} | ja com linha: {ja_tem} | a preencher: {len(planejado)} "
      f"| sem resolver: {len(sem_resolver)}")

por_linha = {}
for _, alvo in planejado:
    por_linha[alvo] = por_linha.get(alvo, 0) + 1
print("\ndistribuicao do que sera preenchido:")
for linha, qtd in sorted(por_linha.items(), key=lambda x: -x[1]):
    print(f"  {linha:<12} {qtd:>4} SKUs")

if sem_resolver:
    print("\nSEM RESOLVER (ficam nulos, caem em 'Outros' ate alguem definir na tela):")
    for p in sem_resolver:
        print(f"  {p['codigo']:<18} familia={p.get('familia') or '(vazia)'} "
              f"| {(p.get('descricao') or '')[:44]}")

if not APLICAR:
    print("\n(simulacao — rode com --aplicar para gravar)")
    sys.exit(0)

for p, alvo in planejado:
    db.table("produtos").update({"linha": alvo}).eq("id", p["id"]).execute()
print(f"\n{len(planejado)} produtos atualizados.")

conf = db.table("produtos").select("linha").execute().data
final = {}
for r in conf:
    k = r.get("linha") or "(nulo)"
    final[k] = final.get(k, 0) + 1
print("estado final:")
for k, v in sorted(final.items(), key=lambda x: -x[1]):
    print(f"  {k:<12} {v:>4}")
