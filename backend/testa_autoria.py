# -*- coding: utf-8 -*-
"""A movimentacao guarda quem agiu?

Com banco FALSO: o app esta em producao e movimentacao nao se apaga — gravar
lixo no historico de uma OV de verdade seria trocar um problema por outro.
"""
import sys
sys.path.insert(0, '.')
from dotenv import load_dotenv
load_dotenv()

from app.services import pedido_service as ps

ok = True


def checa(rotulo, cond, extra=''):
    global ok
    ok = ok and bool(cond)
    print(('   OK   ' if cond else '   *** FALHOU *** ') + rotulo + ('  ' + str(extra) if extra else ''))


USUARIOS = [
    {'id': 'u-laisa', 'nome': 'Laisa Santos'},
    {'id': 'u-mirailton', 'nome': 'Mirailton Santana'},
    {'id': 'u-cristiane', 'nome': 'Cristiane Andrade'},
]
GRAVADO = []


class Q:
    def __init__(self, t):
        self.t, self._eq = t, None

    def select(self, *a, **k):
        return self

    def eq(self, campo, valor):
        self._eq = (campo, valor)
        return self

    def limit(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def insert(self, d):
        GRAVADO.append((self.t, d))
        return self

    def execute(self):
        if self.t == 'usuarios':
            if self._eq:
                return type('R', (), {'data': [u for u in USUARIOS if u['id'] == self._eq[1]]})()
            return type('R', (), {'data': USUARIOS})()
        return type('R', (), {'data': []})()


class Db:
    def table(self, t):
        return Q(t)


ps.get_service_db = lambda: Db()

print('1) grava quem agiu, nao o primeiro da tabela')
GRAVADO.clear()
ps._registrar_movimentacao('ped-1', 'LIBERADO', 'EM_INVENTARIO', 'u-mirailton', 'Inventário iniciado')
mov = [d for t, d in GRAVADO if t == 'movimentacoes'][-1]
checa('usuario_id = quem agiu', mov['usuario_id'] == 'u-mirailton', mov['usuario_id'])
checa('NAO gravou o primeiro da tabela', mov['usuario_id'] != 'u-laisa')

print('\n2) cada passo assinado por quem fez')
GRAVADO.clear()
for quem, de, para in [('u-cristiane', None, 'AGUARD_DADOS_OV'),
                       ('u-laisa', 'AGUARD_DADOS_OV', 'LIBERADO'),
                       ('u-mirailton', 'LIBERADO', 'EM_INVENTARIO')]:
    ps._registrar_movimentacao('ped-1', de, para, quem)
movs = [d for t, d in GRAVADO if t == 'movimentacoes']
assinaturas = [m['usuario_id'] for m in movs]
checa('tres autores diferentes', assinaturas == ['u-cristiane', 'u-laisa', 'u-mirailton'], str(assinaturas))

print('\n3) id que nao existe nao derruba a movimentacao')
GRAVADO.clear()
ps._registrar_movimentacao('ped-1', 'A', 'B', 'u-fantasma', 'passo qualquer')
movs = [d for t, d in GRAVADO if t == 'movimentacoes']
checa('gravou mesmo assim', len(movs) == 1)
checa('sem autor, em vez de autor errado', movs[0]['usuario_id'] is None, str(movs[0]['usuario_id']))

print('\n4) sem usuario informado')
GRAVADO.clear()
ps._registrar_movimentacao('ped-1', 'A', 'B', None)
movs = [d for t, d in GRAVADO if t == 'movimentacoes']
checa('grava sem autor', movs and movs[0]['usuario_id'] is None)

print('\n5) o corte do historico antigo')
from app.api.pedidos import _AUTORIA_CONFIAVEL_A_PARTIR_DE as CORTE
print('   corte =', CORTE)
# 24/08 e o dia do deploy: o que foi gravado antes dele ainda saiu errado, entao
# o dia inteiro fica sem autor.
for data, nome, esperado in [('2026-08-24T10:00:00+00:00', 'Laisa Santos', None),
                             ('2026-08-25T10:00:00+00:00', 'Mirailton Santana', 'Mirailton Santana'),
                             ('2026-08-23T23:59:00+00:00', 'Laisa Santos', None),
                             ('2026-06-02T20:51:02+00:00', 'Administrador', None)]:
    confiavel = str(data)[:10] >= CORTE
    saida = nome if (nome and confiavel) else None
    checa('%s -> %s' % (data[:10], saida or 'sem autor'), saida == esperado)

print('\n' + ('TUDO OK' if ok else '*** TEM FALHA ***'))
