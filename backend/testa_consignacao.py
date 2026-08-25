# -*- coding: utf-8 -*-
"""Consignacao sai igual a venda direta; o que muda e o depois.

    venda direta  -> manda o material e acabou
    consignacao   -> manda o material e, a medida que o cliente usa, gera
                     comunicado de uso

Logo, o contrato de consignacao tem DOIS saldos, e sao coisas diferentes:

    a remeter         = contratado - ja remetido
    na mao do cliente = remetido   - consumido por comunicado de uso

O risco que este teste cobre: a remessa contar como consumo. Se contar, o
contrato aparece 100% cumprido no instante em que o material sai, e os
comunicados de uso seguintes nao acham saldo.

Com banco FALSO — o app esta em producao.
"""
import sys
import uuid

sys.path.insert(0, '.')
from dotenv import load_dotenv
load_dotenv()

from app.services import licitacao_service as L

ok = True


def checa(rotulo, cond, extra=''):
    global ok
    ok = ok and bool(cond)
    print(('   OK   ' if cond else '   *** FALHOU *** ') + rotulo + ('  ' + str(extra) if extra else ''))


EMP = str(uuid.uuid4())
P1 = str(uuid.uuid4())
PEDIDOS = []
ITENS_EMP = [{'empenho_id': EMP, 'produto_id': P1, 'codigo': 'X', 'descricao': 'Cateter',
              'qtd_empenhada': 10, 'valor_unitario': 100.0}]


class _Q:
    def __init__(self, t):
        self.t, self.dentro, self.filtros = t, None, {}

    def select(self, *a, **k):
        return self

    def eq(self, c, v):
        self.filtros[c] = v
        return self

    def neq(self, c, v):
        self.filtros['!' + c] = v
        return self

    def in_(self, c, vs):
        self.dentro = (c, list(vs))
        return self

    def limit(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def single(self):
        return self

    def execute(self):
        if self.t == 'empenhos':
            return type('R', (), {'data': {'id': EMP, 'numero': 'C1', 'tipo': 'CONSIGNACAO',
                                           'cliente_id': 'c', 'clientes': {'nome': 'HUC'},
                                           'canal': 'LICITACAO_VASCULAR', 'vigencia': None}})()
        if self.t == 'empenho_itens':
            return type('R', (), {'data': list(ITENS_EMP)})()
        if self.t == 'pedidos':
            achados = [p for p in PEDIDOS
                       if (not self.dentro or p.get(self.dentro[0]) in self.dentro[1])
                       and all(p.get(c[1:]) != v for c, v in self.filtros.items() if c.startswith('!'))]
            return type('R', (), {'data': achados})()
        return type('R', (), {'data': []})()


class _Db:
    def table(self, t):
        return _Q(t)


L.get_service_db = lambda: _Db()
# Comunicados vinculados: parte que nao interessa a este teste.
L._comunicados_do_empenho = lambda *a, **k: []


def item(qtd):
    return [{'produto_id': P1, 'qtd_solicitada': qtd}]


def saldos():
    d = L.obter_empenho(EMP)
    i = d['itens'][0]
    return i['qtd_a_remeter'], i['qtd_com_cliente'], i['qtd_saldo']


print('1) contrato novo: nada remetido, nada com o cliente')
PEDIDOS[:] = []
a, c, s = saldos()
checa('a remeter 10', a == 10, a)
checa('com o cliente 0', c == 0, c)
checa('saldo do contrato 10', s == 10, s)

print('\n2) remessa de 6 — o material saiu, mas o contrato NAO foi cumprido')
PEDIDOS[:] = [{'id': '1', 'empenho_id': EMP, 'tipo_operacao': 'CONSIGNADO',
               'status': 'EXPEDIDO', 'itens_pedido': item(6)}]
a, c, s = saldos()
checa('a remeter cai para 4', a == 4, a)
checa('com o cliente sobe para 6', c == 6, c)
checa('saldo do contrato SEGUE 10', s == 10, s)

print('\n3) comunicado de uso de 2 — agora sim o contrato baixa')
PEDIDOS.append({'id': '2', 'empenho_id': EMP, 'tipo_operacao': 'COMUNICADO_USO',
                'status': 'FATURADO', 'itens_pedido': item(2)})
a, c, s = saldos()
checa('a remeter continua 4', a == 4, a)
checa('com o cliente cai para 4', c == 4, c)
checa('saldo do contrato cai para 8', s == 8, s)

print('\n4) remessa cancelada nao conta')
PEDIDOS.append({'id': '3', 'empenho_id': EMP, 'tipo_operacao': 'CONSIGNADO',
                'status': 'CANCELADO', 'itens_pedido': item(4)})
a, _, _ = saldos()
checa('a remeter segue 4', a == 4, a)

print('\n5) venda direta: entregar E cumprir — o saldo cai na entrega')
PEDIDOS[:] = [{'id': '4', 'empenho_id': EMP, 'tipo_operacao': 'VENDA_NORMAL',
               'status': 'EXPEDIDO', 'itens_pedido': item(3)}]
a, c, s = saldos()
checa('saldo do contrato cai para 7', s == 7, s)
checa('remessa 0 (venda direta nao remete)', a == 10, a)

print('\n' + ('TUDO OK' if ok else '*** TEM FALHA ***'))
sys.exit(0 if ok else 1)
