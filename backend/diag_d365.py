# -*- coding: utf-8 -*-
"""Descobre o que o D365 de vocês expõe. Rodar depois de configurar as variáveis.

    cd backend
    venv/Scripts/python.exe diag_d365.py

O que faz, em ordem:

  1. diz se a configuração está completa, se o Entra ID dá token e se o D365
     deixa ler — três coisas que falham por motivos diferentes;
  2. procura no catálogo do ambiente as entidades que interessam ao app;
  3. mostra os campos e algumas linhas das que forem encontradas.

Por que descobrir em vez de já codar: o catálogo do F&O muda com a versão e com
os módulos habilitados. Chutar nome de entidade rende 404 que parece falta de
permissão, e a gente perde uma tarde no lugar errado.

SÓ LEITURA. Este script não escreve nada, nem no D365 nem no nosso banco.
"""
import json
import sys

sys.path.insert(0, ".")
from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from app.services import d365_service as d365  # noqa: E402

# O que o app precisa do D365, e por quê. Os termos são de BUSCA, não nomes
# fechados: quem responde qual é o nome certo é o ambiente.
INTERESSES = [
    ("Estoque disponível",
     "acaba com a foto de uma vez ao dia e com o SA que virou PA sem ninguém ver",
     ["OnHand", "InventSum", "Inventory"]),
    ("Ordens de venda",
     "número real da OV, status e itens — hoje a operadora copia à mão do D365",
     ["SalesOrderHeader", "SalesOrderLine"]),
    ("Faturamento",
     "NF emitida e valor, que hoje entram no app por digitação",
     ["SalesInvoice", "CustomerInvoice"]),
    ("Produtos",
     "cadastro e família, para o SKU novo não precisar de cadastro manual",
     ["ReleasedProduct", "ProductsV2"]),
    ("Clientes",
     "razão social e CNPJ, hoje mantidos em paralelo aqui",
     ["CustomersV", "CustomerV"]),
    ("Ordens de produção",
     "previsão de quando o material fica pronto — hoje é o PCP respondendo no WhatsApp",
     ["ProdOrder", "ProductionOrder"]),
]


def secao(titulo: str) -> None:
    print()
    print("=" * 78)
    print(titulo)
    print("=" * 78)


secao("1. A conexão fecha?")
diag = d365.diagnostico()
for chave, valor in diag.items():
    if chave == "erro":
        continue
    print(f"  {chave:<22} {valor}")
if diag.get("erro"):
    print(f"\n  ERRO: {diag['erro']}")

if not diag.get("leitura_ok"):
    print("""
  Enquanto a leitura não fechar, o resto não roda. Onde olhar, conforme o ponto:

    configurado = false   -> faltam variáveis de ambiente (ver o topo de
                             app/services/d365_service.py)
    token_ok = false      -> Entra ID recusou: secret expirado, tenant ou
                             client_id errado
    token_ok = true e
    leitura_ok = false    -> o app NÃO está cadastrado dentro do D365. Em
                             Administração do sistema > Configurar > Aplicativos
                             do Microsoft Entra ID, cadastre o Client ID e
                             vincule a um usuário de serviço com função de
                             leitura. É o esquecimento mais comum, e o mais
                             confuso: o token está válido, e o D365 responde 401.
""")
    raise SystemExit(1)

secao("2. O que este ambiente expõe, do que a gente precisa")
achados = {}
for rotulo, porque, termos in INTERESSES:
    print(f"\n  {rotulo}")
    print(f"    para quê: {porque}")
    encontrados = []
    for termo in termos:
        try:
            encontrados += d365.entidades(busca=termo)
        except d365.D365Indisponivel as e:
            print(f"    (falha ao consultar o catálogo: {e})")
            break
    # Nomes curtos primeiro: no F&O o mais curto costuma ser a entidade
    # principal, e as longas são variações e agregações dela.
    encontrados = sorted(set(encontrados), key=lambda n: (len(n), n))
    if not encontrados:
        print("    NADA ENCONTRADO — o módulo pode não estar habilitado")
    for n in encontrados[:8]:
        print(f"    · {n}")
    if len(encontrados) > 8:
        print(f"    ... e mais {len(encontrados) - 8}")
    if encontrados:
        achados[rotulo] = encontrados[0]

secao("3. Campos e amostra da entidade principal de cada assunto")
for rotulo, entidade in achados.items():
    print(f"\n  {rotulo} -> {entidade}")
    try:
        cs = d365.campos(entidade)
        print(f"    {len(cs)} campos. Os que parecem úteis:")
        chaves = [c for c in cs if any(
            t in c["nome"].lower() for t in
            ("itemnumber", "productnumber", "quantity", "qty", "available", "onhand",
             "salesorder", "invoice", "customer", "status", "date", "amount",
             "warehouse", "dataarea", "name", "number"))]
        for c in chaves[:18]:
            print(f"      {c['nome']:<42} {c['tipo']}")
        if len(chaves) > 18:
            print(f"      ... e mais {len(chaves) - 18} parecidos")
    except Exception as e:
        print(f"    falha ao ler os campos: {e}")

    try:
        linhas = d365.listar(entidade, top=2, cross_company=True)
        print(f"    amostra ({len(linhas)} linha(s)):")
        for linha in linhas:
            # Só as chaves com valor: o F&O devolve centenas de colunas vazias e
            # elas escondem o que interessa.
            preenchidas = {k: v for k, v in linha.items()
                           if v not in (None, "", 0) and not k.startswith("@")}
            print("      " + json.dumps(preenchidas, ensure_ascii=False, default=str)[:400])
    except Exception as e:
        print(f"    falha ao ler a amostra: {e}")

secao("Resumo")
print("""
  Me mande a saída deste script (ou só as partes 2 e 3) e eu escrevo a carga de
  verdade: qual entidade, quais campos, qual filtro e de quanto em quanto tempo.

  A ordem que eu sugiro atacar, por quanto resolve:

    1. Estoque disponível   -> mata a foto de uma vez ao dia e o SA -> PA
    2. Ordens de venda      -> mata a digitação do número da OV
    3. Faturamento          -> mata a digitação de NF e valor
    4. Produtos e clientes  -> mata o cadastro paralelo
""")
