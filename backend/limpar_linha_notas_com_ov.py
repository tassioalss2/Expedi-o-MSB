"""Tira a linha das notas do espelho que TEM OV — elas não usam esse campo.

Uso:
    PYTHONPATH=. ./venv/Scripts/python.exe limpar_linha_notas_com_ov.py

Por que existe: a primeira versão do `importar_base_itens` preencheu a linha de
toda nota sem linha, inclusive as que têm OV. Não muda número nenhum (nota com
OV tira a linha dos itens da própria OV, que é rateio melhor), mas deixa o
espelho afirmando uma coisa que o código diz que não deve afirmar — e com
`linha_ajustada = true`, que significa "alguém informou isto" e sobrevive à
reimportação. O serviço já não faz mais isso; isto limpa o que ficou.

Não toca em devolução: essa precisa da linha, e é o motivo de a importação
existir.
"""
from app.core.database import get_service_db

db = get_service_db()
notas = db.table("notas_d365").select(
    "id, numero, linha, pedido_id, tipo_operacao").limit(20000).execute().data

alvo = [n for n in notas
        if n.get("pedido_id") and n.get("linha") and n.get("tipo_operacao") != "DEVOLUCAO"]
print("notas com OV carregando linha: %d" % len(alvo))

for n in alvo:
    db.table("notas_d365").update({"linha": None, "linha_ajustada": False})\
        .eq("id", n["id"]).execute()

restou = [n for n in db.table("notas_d365").select(
    "numero, linha, pedido_id, tipo_operacao").limit(20000).execute().data
    if n.get("pedido_id") and n.get("linha") and n.get("tipo_operacao") != "DEVOLUCAO"]
print("restaram: %d" % len(restou))
