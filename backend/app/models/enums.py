from enum import Enum


class StatusPedido(str, Enum):
    # Ponto de entrada de uma OV que nasceu de oportunidade ganha no CRM: o
    # cliente e o valor já são conhecidos, mas o número real da OV (do D365) e a
    # data prevista de entrega ainda não — quem completa é a operadora de vendas,
    # direto no card do kanban.
    AGUARD_DADOS_OV = "AGUARD_DADOS_OV"
    AGUARD_CREDITO = "AGUARD_CREDITO"
    LIBERADO = "LIBERADO"
    EM_INVENTARIO = "EM_INVENTARIO"
    AGUARD_VERIFICACAO = "AGUARD_VERIFICACAO"
    DIVERGENCIA = "DIVERGENCIA"
    AGUARD_TRATATIVA = "AGUARD_TRATATIVA"
    EM_PROCESSO_SISTEMICO = "EM_PROCESSO_SISTEMICO"
    EM_COTACAO_FRETE = "EM_COTACAO_FRETE"
    AGUARD_TRANSPORTADORA = "AGUARD_TRANSPORTADORA"
    AGUARD_FATURAMENTO = "AGUARD_FATURAMENTO"
    FATURADO = "FATURADO"
    AGUARD_COLETA = "AGUARD_COLETA"
    COLETADO = "COLETADO"
    EXPEDIDO = "EXPEDIDO"
    BLOQUEADO = "BLOQUEADO"
    CANCELADO = "CANCELADO"


TRANSICOES_PERMITIDAS: dict[StatusPedido, list[StatusPedido]] = {
    StatusPedido.AGUARD_DADOS_OV:        [StatusPedido.LIBERADO, StatusPedido.AGUARD_CREDITO, StatusPedido.CANCELADO],
    StatusPedido.AGUARD_CREDITO:         [StatusPedido.LIBERADO, StatusPedido.BLOQUEADO, StatusPedido.CANCELADO],
    StatusPedido.LIBERADO:               [StatusPedido.EM_INVENTARIO, StatusPedido.BLOQUEADO, StatusPedido.CANCELADO],
    StatusPedido.EM_INVENTARIO:          [StatusPedido.AGUARD_VERIFICACAO, StatusPedido.BLOQUEADO],
    StatusPedido.AGUARD_VERIFICACAO:     [StatusPedido.EM_PROCESSO_SISTEMICO, StatusPedido.DIVERGENCIA],
    StatusPedido.DIVERGENCIA:            [StatusPedido.AGUARD_TRATATIVA],
    StatusPedido.AGUARD_TRATATIVA:       [StatusPedido.EM_INVENTARIO, StatusPedido.EM_PROCESSO_SISTEMICO, StatusPedido.BLOQUEADO, StatusPedido.CANCELADO],
    StatusPedido.EM_PROCESSO_SISTEMICO:  [StatusPedido.EM_COTACAO_FRETE, StatusPedido.AGUARD_TRANSPORTADORA, StatusPedido.AGUARD_FATURAMENTO],
    StatusPedido.EM_COTACAO_FRETE:       [StatusPedido.AGUARD_FATURAMENTO, StatusPedido.EM_PROCESSO_SISTEMICO, StatusPedido.BLOQUEADO],
    StatusPedido.AGUARD_TRANSPORTADORA:  [StatusPedido.AGUARD_FATURAMENTO, StatusPedido.EM_PROCESSO_SISTEMICO, StatusPedido.BLOQUEADO],
    StatusPedido.AGUARD_FATURAMENTO:     [StatusPedido.FATURADO, StatusPedido.EM_COTACAO_FRETE, StatusPedido.AGUARD_TRANSPORTADORA, StatusPedido.BLOQUEADO],
    StatusPedido.FATURADO:               [StatusPedido.AGUARD_COLETA],
    StatusPedido.AGUARD_COLETA:          [StatusPedido.COLETADO],
    StatusPedido.COLETADO:               [StatusPedido.EXPEDIDO],
    StatusPedido.EXPEDIDO:               [],
    StatusPedido.BLOQUEADO:              [StatusPedido.LIBERADO, StatusPedido.EM_INVENTARIO, StatusPedido.CANCELADO],
    StatusPedido.CANCELADO:              [],
}


class TipoFrete(str, Enum):
    FOB = "FOB"
    CIF_COM_VALOR = "CIF_COM_VALOR"
    CIF_SEM_VALOR = "CIF_SEM_VALOR"


class TipoOperacao(str, Enum):
    """Natureza da operação da OV.

    Só VENDA_NORMAL e COMUNICADO_USO contam como faturamento bruto. As demais
    (exceto DEVOLUCAO) geram NF e passam pelo fluxo, mas não são faturamento
    (movimentam estoque). DEVOLUCAO tem tratamento à parte: não soma no bruto,
    mas subtrai do faturamento líquido — é o valor "correto" que o D365 usa
    quando uma venda é estornada (nota de devolução, direção Entrada).
    """
    VENDA_NORMAL = "VENDA_NORMAL"
    COMUNICADO_USO = "COMUNICADO_USO"
    BONIFICACAO_DOACAO = "BONIFICACAO_DOACAO"
    AMOSTRA = "AMOSTRA"
    CONSIGNADO = "CONSIGNADO"
    DEVOLUCAO = "DEVOLUCAO"


# Operações que entram no faturamento
OPERACOES_FATURAMENTO = {TipoOperacao.VENDA_NORMAL.value, TipoOperacao.COMUNICADO_USO.value}


class CanalVenda(str, Enum):
    """Canal comercial responsável pela venda.

    Licitação sempre entra em Uro ou Vascular (o faturamento vai pro canal
    base); LICITACAO puro é legado.
    """
    URO = "URO"
    VASCULAR = "VASCULAR"
    REALCLOSURE = "REALCLOSURE"
    LICITACAO_URO = "LICITACAO_URO"
    LICITACAO_VASCULAR = "LICITACAO_VASCULAR"
    LICITACAO = "LICITACAO"  # legado (antes da separação Uro/Vascular)


class Prioridade(str, Enum):
    NORMAL = "NORMAL"
    ALTA = "ALTA"
    CRITICA = "CRITICA"


class PerfilUsuario(str, Enum):
    """Perfis de acesso do app (5 tipos).

    Política atual: todos os perfis enxergam e operam tudo no sistema;
    a única área restrita é a Gestão de Usuários, exclusiva do ADMIN.
    """
    LOGISTICA = "LOGISTICA"
    OPERACOES_VENDAS = "OPERACOES_VENDAS"
    COMERCIAL = "COMERCIAL"
    DIRETORIA = "DIRETORIA"
    ADMIN = "ADMIN"


# Rótulos amigáveis para exibição
PERFIL_LABELS = {
    PerfilUsuario.LOGISTICA.value: "Logística",
    PerfilUsuario.OPERACOES_VENDAS.value: "Operações de Vendas",
    PerfilUsuario.COMERCIAL.value: "Comercial",
    PerfilUsuario.DIRETORIA.value: "Diretoria",
    PerfilUsuario.ADMIN.value: "Admin / TI",
}


class TipoDivergencia(str, Enum):
    QUANTIDADE_ERRADA = "QUANTIDADE_ERRADA"
    LOTE_ERRADO = "LOTE_ERRADO"
    PRODUTO_TROCADO = "PRODUTO_TROCADO"
    EMBALAGEM_DANIFICADA = "EMBALAGEM_DANIFICADA"
    PRODUTO_VENCIDO = "PRODUTO_VENCIDO"
    AUSENCIA_ITEM = "AUSENCIA_ITEM"
    OUTRO = "OUTRO"


class ResultadoConferencia(str, Enum):
    OK = "OK"
    DIVERGENCIA = "DIVERGENCIA"


class StatusOcorrencia(str, Enum):
    ABERTA = "ABERTA"
    EM_TRATATIVA = "EM_TRATATIVA"
    FECHADA = "FECHADA"


class DecisaoTratativa(str, Enum):
    CORRIGIR = "CORRIGIR"
    EXPEDIR_PARCIAL = "EXPEDIR_PARCIAL"
    BLOQUEAR = "BLOQUEAR"
