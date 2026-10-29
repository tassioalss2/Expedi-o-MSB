r"""Carrega a base de faturamento item a item (a que alimenta Inteligência).

Uso:
    $env:PYTHONPATH = "."
    .\venv\Scripts\python.exe importar_faturamento_itens.py <planilha> [...] [--custo <planilha>]

A planilha é a mesma "Base de NF" / "Export" do D365, uma linha por item de
fatura. Pode passar vários arquivos; cada competência encontrada é substituída
inteira antes de gravar, então rodar de novo com um export atualizado não
duplica — mas um arquivo com o mês PELA METADE substitui o mês inteiro pela
metade. Para mês fechado, use o export completo.

`--custo` é a planilha de movimentação de estoque por OV, de onde sai o custo
médio por produto. Sem ela a carga funciona e a MARGEM fica em branco.
"""
import os
import sys

from app.services import faturamento_import_service as fi


def main(argv: list) -> int:
    custo = None
    arquivos = []
    i = 0
    while i < len(argv):
        if argv[i] == "--custo":
            i += 1
            if i >= len(argv):
                print("--custo precisa do caminho da planilha.")
                return 2
            custo = argv[i]
        else:
            arquivos.append(argv[i])
        i += 1

    if not arquivos:
        print(__doc__)
        return 2

    # Confere TODOS os caminhos antes de gravar qualquer coisa: com dois
    # arquivos, descobrir o erro de digitação no segundo deixaria metade da
    # carga feita e a outra metade não.
    faltando = [c for c in arquivos + ([custo] if custo else []) if not os.path.isfile(c)]
    if faltando:
        for c in faltando:
            print("Não achei o arquivo: %s" % c)
        print("\nPasse o caminho da planilha que você baixou do D365 — entre aspas,\n"
              "porque ele tem espaços. Nada foi gravado.")
        return 2

    for caminho in arquivos:
        print("\n== %s" % caminho)
        try:
            r = fi.importar(caminho, custo, substituir=True)
        except ValueError as e:                     # layout diferente
            print("   recusado: %s" % e)
            return 1
        except Exception as e:                      # arquivo corrompido, não é xlsx…
            print("   não consegui ler a planilha: %s" % e)
            return 1
        print("   %d linha(s) · competências %s" % (r["linhas"], ", ".join(r["competencias"])))
        print("   receita R$ %.2f" % r["receita"])
        if r["produtos_com_custo"]:
            print("   margem %.1f%% · %d produto(s) com custo · %d sem"
                  % (r["margem_pct"] or 0, r["produtos_com_custo"], len(r["produtos_sem_custo"])))
        else:
            print("   sem planilha de custo: margem fica em branco nestes meses.")
        # Só o custo é global; passar de novo em cada arquivo reescreveria a
        # mesma foto sem motivo.
        custo = None
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
