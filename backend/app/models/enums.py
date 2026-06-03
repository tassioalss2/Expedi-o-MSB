from enum import Enum


class StatusPedido(str, Enum):
    LIBERADO = "LIBERADO"
    EM_INVENTARIO = "EM_INVENTARIO"
    AGUARD_VERIFICACAO = "AGUARD_VERIFICACAO"
    DIVERGENCIA = "DIVERGENCIA"
    AGUARD_TRATATIVA = "AGUARD_TRATATIVA"
    EM_PROCESSO_SISTEMICO = "EM_PROCESSO_SISTEMICO"
    AGUARD_FATURAMENTO = "AGUARD_FATURAMENTO"
    FATURADO = "FATURADO"
    AGUARD_COLETA = "AGUARD_COLETA"
    COLETADO = "COLETADO"
    EXPEDIDO = "EXPEDIDO"
    BLOQUEADO = "BLOQUEADO"
    CANCELADO = "CANCELADO"


TRANSICOES_PERMITIDAS: dict[StatusPedido, list[StatusPedido]] = {
    StatusPedido.LIBERADO:               [StatusPedido.EM_INVENTARIO, StatusPedido.BLOQUEADO, StatusPedido.CANCELADO],
    StatusPedido.EM_INVENTARIO:          [StatusPedido.AGUARD_VERIFICACAO, StatusPedido.BLOQUEADO],
    StatusPedido.AGUARD_VERIFICACAO:     [StatusPedido.EM_PROCESSO_SISTEMICO, StatusPedido.DIVERGENCIA],
    StatusPedido.DIVERGENCIA:            [StatusPedido.AGUARD_TRATATIVA],
    StatusPedido.AGUARD_TRATATIVA:       [StatusPedido.EM_INVENTARIO, StatusPedido.EM_PROCESSO_SISTEMICO, StatusPedido.BLOQUEADO, StatusPedido.CANCELADO],
    StatusPedido.EM_PROCESSO_SISTEMICO:  [StatusPedido.AGUARD_FATURAMENTO],
    StatusPedido.AGUARD_FATURAMENTO:     [StatusPedido.FATURADO, StatusPedido.BLOQUEADO],
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


class Prioridade(str, Enum):
    NORMAL = "NORMAL"
    ALTA = "ALTA"
    CRITICA = "CRITICA"


class PerfilUsuario(str, Enum):
    OPERADOR = "OPERADOR"
    CONFERENTE = "CONFERENTE"
    LIDER = "LIDER"
    SUPERVISOR = "SUPERVISOR"
    FATURAMENTO = "FATURAMENTO"
    QUALIDADE = "QUALIDADE"
    GERENCIA = "GERENCIA"
    ADMIN = "ADMIN"


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
