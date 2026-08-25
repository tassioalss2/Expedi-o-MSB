# -*- coding: utf-8 -*-
"""Uma AF, varias notas fiscais.

O caso real, tirado do e-mail da licitacao de 24/08/2026:

    NF 20476 e NF 20480, referente ao comunicado de uso 57048
    NF 20482,            referente ao comunicado de uso 57046
    NF 20485 e NF 20489, referente ao comunicado de uso 57044

Com banco FALSO. O app esta em producao e comunicado de uso entra FATURADO —
lancar nota de teste sujaria o faturamento do mes.
"""
import sys
import uuid

sys.path.insert(0, '.')
from dotenv import load_dotenv
load_dotenv()

from fastapi import HTTPException

from app.models.schemas import DemandaConcluir, DemandaCreate, DemandaItem, NotaComunicado
from app.services import licitacao_demanda_service as S

ok = True


def checa(rotulo, cond, extra=''):
    global ok
    ok = ok and bool(cond)
    print(('   OK   ' if cond else '   *** FALHOU *** ') + rotulo + ('  ' + str(extra) if extra else ''))


def recusa(rotulo, fn, trecho):
    """A recusa precisa dizer O QUE fazer — mensagem generica devolve o problema
    para quem esta lancando sem dizer onde olhar."""
    global ok
    try:
        fn()
    except HTTPException as e:
        bom = trecho.lower() in str(e.detail).lower()
        ok = ok and bom
        print(('   OK   ' if bom else '   *** FALHOU *** ') + rotulo + '  -> ' + str(e.detail)[:88])
        return
    ok = False
    print('   *** FALHOU *** ' + rotulo + '  -> nao recusou')


P1, P2 = str(uuid.uuid4()), str(uuid.uuid4())
CLI = str(uuid.uuid4())


def nota(nf, itens, ov=None):
    return NotaComunicado(numero_nf=nf, numero_pedido=ov, itens=[
        DemandaItem(produto_id=p, codigo=c, qtd=q, valor=v) for p, c, q, v in itens])


print('1) o valor de cada nota sai dos seus itens')
n1 = nota('20476', [(P1, '58041', 2, 500)])
n2 = nota('20480', [(P1, '58041', 1, 500), (P2, '51395', 3, 120)])
checa('NF 20476 = 1000', n1.valor == 1000, n1.valor)
checa('NF 20480 = 860', n2.valor == 860, n2.valor)

print('\n2) as duas notas convivem na mesma AF')
d = DemandaCreate(tipo_operacao='COMUNICADO_USO', cliente_id=CLI, numero='57048',
                  nome_paciente='VFM', prontuario='711476',
                  canal='LICITACAO_VASCULAR', data_procedimento='2026-06-29',
                  notas=[n1, n2])
notas = S._notas_normalizadas(d)
S._validar_notas_comunicado(notas)
checa('duas notas', len(notas) == 2, len(notas))
checa('valores 1000 e 860', [S._valor_da_nota(x) for x in notas] == [1000, 860])

print('\n3) o espelho (coluna itens) preserva o total')
espelho = S._itens_das_notas(notas)
total_notas = sum(S._valor_da_nota(x) for x in notas)
total_espelho = sum(i['qtd'] * i['valor'] for i in espelho)
checa('soma bate com as notas', abs(total_espelho - total_notas) < 0.01,
      '%.2f vs %.2f' % (total_espelho, total_notas))
checa('58041 com qtd 3', any(i['codigo'] == '58041' and i['qtd'] == 3 for i in espelho), espelho)

print('\n4) o mesmo item com preco diferente em duas notas')
a = nota('30001', [(P1, 'X', 2, 100)])
b = nota('30002', [(P1, 'X', 2, 200)])
esp = S._itens_das_notas(S._notas_normalizadas(
    DemandaCreate(tipo_operacao='COMUNICADO_USO', cliente_id=CLI, numero='1',
                  notas=[a, b])))
checa('unitario = media ponderada (150)', esp[0]['valor'] == 150, esp[0]['valor'])
checa('qtd x valor = 600', esp[0]['qtd'] * esp[0]['valor'] == 600)

print('\n5) o que a validacao recusa')
recusa('nenhuma nota', lambda: S._validar_notas_comunicado([]), 'pelo menos uma nota')
recusa('NF repetida na mesma AF',
       lambda: S._validar_notas_comunicado(S._notas_normalizadas(
           DemandaCreate(tipo_operacao='COMUNICADO_USO', cliente_id=CLI, numero='1',
                         notas=[nota('20476', [(P1, 'X', 1, 10)]),
                                nota('20476', [(P2, 'Y', 1, 10)])]))),
       'repetida')
recusa('nota sem item',
       lambda: S._validar_notas_comunicado([{'numero_nf': '999', 'itens': []}]),
       'itens e quantidades da NF 999')
recusa('item sem valor unitario',
       lambda: S._validar_notas_comunicado(
           [{'numero_nf': '888', 'itens': [{'produto_id': P1, 'qtd': 2, 'valor': 0}]}]),
       'valor unitário de cada item da NF 888')
try:
    NotaComunicado(numero_nf='   ', itens=[])
    print('   *** FALHOU *** NF em branco -> nao recusou')
    ok = False
except Exception as e:
    print('   OK   NF em branco  -> ' + str(e).splitlines()[-1][:70])

print('\n6) a forma antiga da API continua valendo (uma NF solta)')
velho = DemandaCreate(tipo_operacao='COMUNICADO_USO', cliente_id=CLI, numero='57046',
                      numero_nf='20482',
                      itens=[DemandaItem(produto_id=P1, codigo='58041', qtd=3, valor=100)])
nv = S._notas_normalizadas(velho)
checa('virou uma nota', len(nv) == 1 and nv[0]['numero_nf'] == '20482')
checa('com valor 300', S._valor_da_nota(nv[0]) == 300, S._valor_da_nota(nv[0]))

print('\n7) conclusao: cada nota precisa do seu numero de lancamento')
conc = DemandaConcluir(numero='57048', cliente_id=CLI,
                       notas=[nota('20476', [(P1, 'X', 1, 10)], ov='OV016364'),
                              nota('20480', [(P1, 'X', 1, 10)])])
nc = S._notas_normalizadas(conc)
faltando = [n['numero_nf'] for n in nc if not (n.get('numero_pedido') or '').strip()]
checa('detecta a nota sem OV', faltando == ['20480'], faltando)

print('\n' + ('TUDO OK' if ok else '*** TEM FALHA ***'))
sys.exit(0 if ok else 1)
