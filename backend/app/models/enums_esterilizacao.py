from enum import Enum


class StatusCarga(str, Enum):
    PLANEJADA       = "PLANEJADA"
    LIBERADA        = "LIBERADA"
    EM_PRODUCAO     = "EM_PRODUCAO"
    EM_SEPARACAO    = "EM_SEPARACAO"
    EM_CONFERENCIA  = "EM_CONFERENCIA"
    PRONTA          = "PRONTA"
    ENVIADA         = "ENVIADA"
    RETORNADA       = "RETORNADA"
    ATRASADA        = "ATRASADA"
    BLOQUEADA       = "BLOQUEADA"
    CANCELADA       = "CANCELADA"


class PrioridadeCarga(str, Enum):
    ALTA   = "ALTA"
    NORMAL = "NORMAL"
    BAIXA  = "BAIXA"


class TipoCaixa(str, Enum):
    VERDE    = "VERDE"
    BRANCA   = "BRANCA"
    AMARELA  = "AMARELA"
    VERMELHA = "VERMELHA"


class EtapaApontamento(str, Enum):
    PRODUCAO    = "PRODUCAO"
    SEPARACAO   = "SEPARACAO"
    CONFERENCIA = "CONFERENCIA"
    EMBALAGEM   = "EMBALAGEM"


# Transições de status permitidas — máquina de estados da carga
TRANSICOES_CARGA: dict[StatusCarga, list[StatusCarga]] = {
    StatusCarga.PLANEJADA:      [StatusCarga.LIBERADA, StatusCarga.BLOQUEADA, StatusCarga.CANCELADA],
    StatusCarga.LIBERADA:       [StatusCarga.EM_PRODUCAO, StatusCarga.BLOQUEADA, StatusCarga.CANCELADA],
    StatusCarga.EM_PRODUCAO:    [StatusCarga.EM_SEPARACAO, StatusCarga.BLOQUEADA],
    StatusCarga.EM_SEPARACAO:   [StatusCarga.EM_CONFERENCIA, StatusCarga.BLOQUEADA],
    StatusCarga.EM_CONFERENCIA: [StatusCarga.PRONTA, StatusCarga.EM_SEPARACAO],
    StatusCarga.PRONTA:         [StatusCarga.ENVIADA, StatusCarga.BLOQUEADA],
    StatusCarga.ENVIADA:        [StatusCarga.RETORNADA],
    StatusCarga.RETORNADA:      [],
    StatusCarga.ATRASADA:       [StatusCarga.LIBERADA, StatusCarga.EM_PRODUCAO, StatusCarga.BLOQUEADA, StatusCarga.CANCELADA],
    StatusCarga.BLOQUEADA:      [StatusCarga.PLANEJADA, StatusCarga.LIBERADA, StatusCarga.EM_PRODUCAO, StatusCarga.CANCELADA],
    StatusCarga.CANCELADA:      [],
}

# Status que indicam carga ainda ativa (não encerrada)
STATUS_ATIVOS = {
    StatusCarga.PLANEJADA, StatusCarga.LIBERADA, StatusCarga.EM_PRODUCAO,
    StatusCarga.EM_SEPARACAO, StatusCarga.EM_CONFERENCIA, StatusCarga.PRONTA,
    StatusCarga.ATRASADA, StatusCarga.BLOQUEADA,
}

# Status que não devem receber flag de atraso
STATUS_ENCERRADOS = {StatusCarga.ENVIADA, StatusCarga.RETORNADA, StatusCarga.CANCELADA}
