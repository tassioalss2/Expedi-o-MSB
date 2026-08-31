from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, field_validator, model_validator, Field

from app.models.enums import (
    DecisaoTratativa,
    PerfilUsuario,
    Prioridade,
    ResultadoConferencia,
    StatusOcorrencia,
    StatusPedido,
    CanalVenda,
    FormaVenda,
    TipoDivergencia,
    TipoFrete,
    TipoOperacao,
)


# ── Auth ──────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    senha: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    usuario: "UsuarioOut"


# ── Usuário ───────────────────────────────────────────────────────────────────

class UsuarioCreate(BaseModel):
    nome: str
    email: EmailStr
    senha: str
    perfil: PerfilUsuario


class UsuarioOut(BaseModel):
    id: UUID
    nome: str
    email: str
    perfil: PerfilUsuario
    ativo: bool


class UsuarioUpdate(BaseModel):
    nome: Optional[str] = None
    perfil: Optional[PerfilUsuario] = None
    ativo: Optional[bool] = None


class SenhaUpdate(BaseModel):
    nova_senha: str


# ── Cliente ───────────────────────────────────────────────────────────────────

class ClienteCreate(BaseModel):
    codigo: str
    nome: str
    cnpj: Optional[str] = None
    contato: Optional[str] = None
    prioridade: int = 0


class ClienteOut(BaseModel):
    id: UUID
    codigo: str
    nome: str
    cnpj: Optional[str]
    contato: Optional[str]
    prioridade: int
    ativo: bool


# ── Transportadora ────────────────────────────────────────────────────────────

class TransportadoraCreate(BaseModel):
    nome: str
    cnpj: Optional[str] = None
    contato: Optional[str] = None
    sla_horas: int = 24


class TransportadoraOut(BaseModel):
    id: UUID
    nome: str
    cnpj: Optional[str]
    contato: Optional[str]
    sla_horas: int
    ativo: bool


# ── Produto / Lote ────────────────────────────────────────────────────────────

class ProdutoCreate(BaseModel):
    codigo: str
    descricao: str
    familia: Optional[str] = None
    # Linha comercial (URO / VASCULAR / REALCLOSURE). Em branco cai no fallback
    # por família — ver app/services/linha_produto.py.
    linha: Optional[str] = None
    unidade: str = "UN"

    @field_validator("linha")
    @classmethod
    def _valida_linha(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip().upper()
        if v not in ("URO", "VASCULAR", "REALCLOSURE"):
            raise ValueError("Linha deve ser URO, VASCULAR ou REALCLOSURE.")
        return v


class ProdutoUpdate(BaseModel):
    descricao: Optional[str] = None
    familia: Optional[str] = None
    linha: Optional[str] = None
    unidade: Optional[str] = None

    _valida_linha = field_validator("linha")(ProdutoCreate._valida_linha.__func__)


class ProdutoOut(BaseModel):
    id: UUID
    codigo: str
    descricao: str
    familia: Optional[str]
    linha: Optional[str] = None
    unidade: str
    ativo: bool


class LoteCreate(BaseModel):
    produto_id: UUID
    numero_lote: str
    validade: Optional[date] = None
    quantidade_disp: float = 0


class LoteOut(BaseModel):
    id: UUID
    produto_id: UUID
    numero_lote: str
    validade: Optional[date]
    quantidade_disp: float


# ── Item do Pedido ────────────────────────────────────────────────────────────

class ItemPedidoCreate(BaseModel):
    produto_id: UUID
    lote_id: Optional[UUID] = None
    qtd_solicitada: float
    # Preço unitário herdado da origem (cotação/oportunidade/contrato) — permite
    # sugerir o valor da NF no faturamento sem redigitar.
    valor_unitario: Optional[float] = None

    @field_validator("qtd_solicitada")
    @classmethod
    def qtd_positiva(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Quantidade deve ser maior que zero")
        return v


class DadosOVUpdate(BaseModel):
    """Correção dos dados cadastrais da OV antes do faturamento. Só os campos
    enviados mudam — o resto fica como está."""
    cliente_id: Optional[UUID] = None
    tipo_operacao: Optional[str] = None
    forma_venda: Optional[str] = None
    prioridade: Optional[str] = None
    condicao_pagamento: Optional[str] = None
    local_entrega: Optional[str] = None
    data_prevista_entrega: Optional[date] = None
    observacoes: Optional[str] = None

    def alteracoes(self) -> dict:
        """Só o que veio no corpo — distingue "não mandou" de "mandou vazio"."""
        d = self.model_dump(exclude_unset=True)
        for k in ("cliente_id", "data_prevista_entrega"):
            if d.get(k) is not None:
                d[k] = str(d[k])
        return d


class DevolverReservaRequest(BaseModel):
    """Libera para o estoque parte do que uma OV reservou. O saldo vai para a
    pendência da OV — o material continua vendido."""
    codigo: str
    qtd: float = Field(gt=0)
    observacao: Optional[str] = None


class ReclassificarCanalRequest(BaseModel):
    """Reclassifica uma OV que ainda não tem canal definido (legado
    'LICITACAO' puro, ou sem canal nenhum) para o canal correto."""
    canal: CanalVenda


class ItemPedidoOut(BaseModel):
    id: UUID
    produto_id: UUID
    lote_id: Optional[UUID]
    qtd_solicitada: float
    qtd_separada: Optional[float]
    qtd_conferida: Optional[float]
    qtd_divergente: Optional[float]
    status_item: str
    produto: Optional[ProdutoOut] = None
    lote: Optional[LoteOut] = None


# ── Pedido ────────────────────────────────────────────────────────────────────

# ── Pendência de estoque ──────────────────────────────────────────────────────
# Decisão do comercial quando não há material para toda a venda. O mesmo par de
# opções serve à OV manual, ao ganho no CRM e à venda outbound, então mora num
# mixin em vez de ser redigitado em cada schema.
_DECISOES_ESTOQUE = ("PARCIAL", "AGUARDAR")


# Operacoes que NAO sao OV e por isso tem numeracao propria: devolucao usa
# DEV+numero da nota estornada, comunicado de uso usa CU/NF. Barrar o prefixo
# delas quebraria fluxo que funciona.
_OPERACOES_SEM_NUMERO_OV = ("DEVOLUCAO", "COMUNICADO_USO")

# Provisorios gerados pelo proprio app, substituidos pelo numero real depois.
_PREFIXOS_PROVISORIOS = ("CRM-", "OUT-")


def validar_numero_ov(valor: str) -> str:
    """Normaliza e exige o formato OV + digitos.

    Existe porque o erro real e sempre o mesmo: entra o numero do CONTRATO
    (MSB-000206), o numero da NF, ou o numero da OV sem o "OV" na frente. Ja
    aconteceu com OV faturada e entregue, e a correcao depois custa bem mais do
    que a recusa na hora.

    O ponto final sobrando ("MSB-000206.") e a digitacao com espaco entram na
    limpeza — sao escorregao de teclado, nao decisao de ninguem.
    """
    n = (valor or "").strip().upper().rstrip(". ").replace(" ", "")
    if not n:
        raise ValueError("Informe o número da OV.")
    if n.startswith(_PREFIXOS_PROVISORIOS):
        return n
    if not n.startswith("OV"):
        raise ValueError(
            "O número da OV precisa começar com 'OV' — veio '%s'. "
            "Se o que você tem em mão é o número do contrato (MSB-...) ou da nota, "
            "esse não é o número da OV." % valor
        )
    if not n[2:].isdigit():
        raise ValueError(
            "Depois do 'OV' só entram números — veio '%s'." % valor
        )
    return n


class CondicaoPagamentoMixin(BaseModel):
    """Toda OV nasce com a condição de pagamento negociada — sem ela, quem fatura
    depois não sabe em que prazo cobrar.

    Texto livre de propósito: a condição vem de negociação e varia caso a caso
    ("30 dias", "28/56/84", "à vista", "empenho — 30 dias após liquidação"), então
    uma lista fixa envelheceria e forçaria o operador a escolher o item errado.
    """
    condicao_pagamento: str

    @field_validator("condicao_pagamento")
    @classmethod
    def _exige_condicao_pagamento(cls, v: str) -> str:
        if not (v or "").strip():
            raise ValueError("Informe a condição de pagamento.")
        return v.strip()


class ItemEscolhidoEstoque(BaseModel):
    """Quanto de um item o operador escolheu levar agora, quando falta material.

    O servidor ainda limita ao disponível (ver aplicar_escolha): a escolha pode
    reduzir, nunca aumentar.
    """
    produto_id: UUID
    qtd: float = Field(ge=0)


class DecisaoEstoqueMixin(BaseModel):
    """`decisao_estoque` só é exigida depois de o app responder 409 dizendo que
    falta material. Fora disso fica None e nada muda no fluxo."""
    decisao_estoque: Optional[str] = None
    observacao_estoque: Optional[str] = None
    # Escolha item a item de quanto levar agora. Vazio = leva todo o disponível
    # (comportamento anterior). O resto vira pendência.
    itens_escolhidos: Optional[list[ItemEscolhidoEstoque]] = None
    # Data em que o PCP prevê ter o saldo. Preenchida à mão por quem acompanha a
    # produção — o app ainda não recebe plano de produção do PCP.
    previsao_pcp: Optional[date] = None

    @field_validator("decisao_estoque")
    @classmethod
    def _valida_decisao(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not str(v).strip():
            return None
        d = str(v).strip().upper()
        if d not in _DECISOES_ESTOQUE:
            raise ValueError("Decisão deve ser PARCIAL (seguir com o disponível) ou AGUARDAR.")
        return d

    def previsao_pcp_iso(self) -> Optional[str]:
        """A pendência é gravada em jsonb, e `date` não serializa em JSON."""
        return self.previsao_pcp.isoformat() if self.previsao_pcp else None

    def escolha_por_produto(self) -> dict:
        """{produto_id: qtd} para aplicar_escolha. Vazio quando não houve escolha."""
        return {str(i.produto_id): float(i.qtd) for i in (self.itens_escolhidos or [])}


class AdicionarItensRequest(DecisaoEstoqueMixin):
    """Acrescenta itens a uma OV existente, conferindo estoque. Aditivo: não
    substitui os itens que já estão lá, e SOMA na pendência em vez de trocá-la."""
    itens: list[ItemPedidoCreate]


class EditarItensRequest(DecisaoEstoqueMixin):
    """Editar itens passa pela MESMA regra de estoque da criação: a OV fica com o
    que existe e o saldo vira pendência. Herda `decisao_estoque` para o operador
    confirmar o parcial depois do 409, como em Nova OV."""
    itens: list[ItemPedidoCreate]


class PedidoCreate(DecisaoEstoqueMixin, CondicaoPagamentoMixin):
    """OV manual cadastrada por operações de vendas (número já emitido no D365).

    Herda a decisão de estoque, mas aqui a única escolha válida é PARCIAL: a OV já
    existe no D365, então "aguardar produção" não se aplica — o que o app decide é
    se a expedição recebe a OV inteira ou só a parte que há em estoque.
    """
    numero_pedido: str
    cliente_id: UUID
    transportadora_id: Optional[UUID] = None
    tipo_frete: TipoFrete = TipoFrete.FOB
    tipo_operacao: TipoOperacao = TipoOperacao.VENDA_NORMAL
    # A LINHA (Uro/Vascular/Realclosure) não é mais digitada: sai dos itens.
    # Só sobra o COMO. `canal` fica aceito para compatibilidade e é
    # sobrescrito pelo derivado quando há itens.
    forma_venda: Optional[FormaVenda] = None
    canal: Optional[CanalVenda] = None
    local_entrega: Optional[str] = None
    data_prevista_entrega: date
    data_prevista_coleta: Optional[date] = None
    prioridade: Prioridade = Prioridade.NORMAL
    observacoes: Optional[str] = None
    itens: list[ItemPedidoCreate] = []
    # Frete cotado antes da OV (licitações) — pré-preenche o custo no faturamento
    valor_frete: Optional[float] = None
    # Vínculo com contrato/empenho de licitação (baixa de saldo em venda direta)
    empenho_id: Optional[UUID] = None
    # Recriação de OV cancelada — preenchidos apenas quando o operador confirma a duplicata
    forcar_duplicata: bool = False
    motivo_duplicata: Optional[str] = None
    # Faturamento parcial — cria nova OV derivada vinculada à OV original
    criar_derivada: bool = False
    # OV em gerenciamento de crédito — inicia no status AGUARD_CREDITO
    em_gerenciamento_credito: bool = False

    @model_validator(mode="after")
    def _exige_numero_ov(self):
        # Depois dos outros campos: a regra depende do tipo de operação, e
        # devolução / comunicado de uso têm numeração própria.
        op = self.tipo_operacao.value if hasattr(self.tipo_operacao, "value") else self.tipo_operacao
        if op in _OPERACOES_SEM_NUMERO_OV:
            self.numero_pedido = (self.numero_pedido or "").strip()
        else:
            self.numero_pedido = validar_numero_ov(self.numero_pedido)
        return self


class PedidoOutboundCreate(DecisaoEstoqueMixin, CondicaoPagamentoMixin):
    """Venda outbound fechada direto pelo comercial, sem passar pelo funil do
    CRM. Mesmos dados da 'Nova OV' manual, exceto número da OV (operações
    de vendas emite no D365 depois) e gerenciamento de crédito (não se aplica
    aqui). O CNPJ é obrigatório porque essas vendas frequentemente envolvem
    cliente novo/prospect ainda sem o cadastro completo."""
    cliente_id: UUID
    cliente_cnpj: str
    transportadora_id: Optional[UUID] = None
    tipo_frete: TipoFrete = TipoFrete.FOB
    tipo_operacao: TipoOperacao = TipoOperacao.VENDA_NORMAL
    # A LINHA (Uro/Vascular/Realclosure) não é mais digitada: sai dos itens.
    # Só sobra o COMO. `canal` fica aceito para compatibilidade e é
    # sobrescrito pelo derivado quando há itens.
    forma_venda: Optional[FormaVenda] = None
    canal: Optional[CanalVenda] = None
    local_entrega: Optional[str] = None
    data_prevista_entrega: date
    prioridade: Prioridade = Prioridade.NORMAL
    observacoes: Optional[str] = None
    itens: list[ItemPedidoCreate] = []

    @field_validator("cliente_cnpj")
    @classmethod
    def _valida_cnpj(cls, v: str) -> str:
        limpo = "".join(ch for ch in (v or "") if ch.isdigit())
        if len(limpo) != 14:
            raise ValueError("Informe um CNPJ válido (14 dígitos).")
        return limpo


class ComunicadoUsoCreate(BaseModel):
    """Faturamento de estoque consignado já utilizado pelo cliente.

    Não passa por logística nem movimenta estoque (o material já está com o
    cliente). Entra direto como FATURADO e conta no faturamento.
    """
    numero_pedido: str
    cliente_id: UUID
    numero_nf: str
    valor_nf: float
    canal: Optional[str] = None
    valor_produtos: Optional[float] = None
    data_faturamento: Optional[date] = None
    observacoes: Optional[str] = None
    itens: list[ItemPedidoCreate] = []
    empenho_id: Optional[UUID] = None
    af: Optional[str] = None
    nome_paciente: Optional[str] = None
    prontuario: Optional[str] = None
    data_procedimento: Optional[date] = None


class DevolucaoCreate(BaseModel):
    """Registro de devolução de venda (nota de entrada estornando uma NF
    anterior). Não soma no faturamento bruto — subtrai do faturamento
    líquido, igual ao "Valor correto" que o D365 já calcula pra essas notas."""
    numero_pedido: str
    cliente_id: UUID
    numero_nf: str
    valor: float  # informado positivo (valor devolvido); gravado como negativo
    canal: Optional[str] = None
    data_devolucao: Optional[date] = None
    motivo: Optional[str] = None

    @field_validator("valor")
    @classmethod
    def _valor_positivo(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Informe o valor devolvido como um número positivo.")
        return v


# ── Licitações / Empenhos ──────────────────────────────────────────────────────

class EmpenhoItemCreate(BaseModel):
    produto_id: UUID
    qtd_empenhada: float
    valor_unitario: float = 0

    @field_validator("qtd_empenhada")
    @classmethod
    def _qtd_pos(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Quantidade empenhada deve ser maior que zero")
        return v


class EmpenhoCreate(BaseModel):
    numero: str
    numero_pregao: Optional[str] = None  # nº do pregão (licitação), ex: 90051/2025
    cliente_id: UUID
    tipo: str = "CONSIGNACAO"  # CONSIGNACAO | VENDA_DIRETA
    canal: Optional[str] = None
    data_empenho: Optional[date] = None
    vigencia: Optional[date] = None
    observacao: Optional[str] = None
    itens: list[EmpenhoItemCreate] = []
    pregao_id: Optional[UUID] = None  # vínculo com o pregão mestre (NE de um pregão)

    @field_validator("numero")
    @classmethod
    def _strip_numero(cls, v: str) -> str:
        return v.strip() if v else v


# ── Pregão (mestre) ─────────────────────────────────────────────────────────────

class PregaoItemCreate(BaseModel):
    produto_id: UUID
    qtd_total: float
    valor_unitario: float = 0

    @field_validator("qtd_total")
    @classmethod
    def _qtd_pos(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Quantidade total deve ser maior que zero")
        return v


class PregaoCreate(BaseModel):
    numero: str
    cliente_id: UUID
    canal: Optional[str] = None
    tipo: str = "VENDA_DIRETA"
    data: Optional[date] = None
    vigencia: Optional[date] = None
    observacao: Optional[str] = None
    itens: list[PregaoItemCreate] = []

    @field_validator("numero")
    @classmethod
    def _strip_numero(cls, v: str) -> str:
        return v.strip() if v else v


class NeItemCreate(BaseModel):
    produto_id: UUID
    qtd: float

    @field_validator("qtd")
    @classmethod
    def _qtd_pos(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Quantidade da NE deve ser maior que zero")
        return v


class NeCreate(BaseModel):
    """Nota de empenho registrada dentro de um pregão — consome o saldo do pregão."""
    numero: str
    data_empenho: Optional[date] = None
    vigencia: Optional[date] = None
    observacao: Optional[str] = None
    itens: list[NeItemCreate] = []

    @field_validator("numero")
    @classmethod
    def _strip_numero(cls, v: str) -> str:
        return v.strip() if v else v


class EntregaVendaDiretaCreate(CondicaoPagamentoMixin):
    """Entrega parcial de um contrato de venda direta — gera uma OV que baixa o saldo."""
    numero_pedido: str
    tipo_frete: str = "FOB"
    canal: Optional[str] = None
    forma_venda: Optional[FormaVenda] = None
    data_prevista_entrega: date
    local_entrega: Optional[str] = None
    itens: list[ItemPedidoCreate] = []
    concluir: bool = False
    transportadora_id: Optional[UUID] = None
    valor_frete: Optional[float] = None

    @field_validator("numero_pedido")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip() if v else v


class DemandaFreteCreate(BaseModel):
    """Cotação de frete de uma demanda de licitação (CIF sem valor)."""
    transportadora_id: Optional[UUID] = None
    transportadora_nome: Optional[str] = None
    valor: Optional[float] = None
    prazo_dias: Optional[int] = None
    tipo_frete: str = "CIF_SEM_VALOR"
    observacao: Optional[str] = None


class DemandaNFEnvioCreate(BaseModel):
    """Registro do envio da NF ao cliente (fechamento da demanda)."""
    numero: Optional[str] = None
    enviada_em: Optional[date] = None
    observacao: Optional[str] = None


class DemandaEstoqueCreate(BaseModel):
    """Sinaliza que a demanda de licitação está sem estoque disponível. Guarda a
    previsão do PCP e, opcionalmente, o prazo contratual de entrega — cruzados
    para alertar risco de multa por atraso."""
    previsao_pcp: Optional[date] = None
    prazo: Optional[date] = None
    itens_faltantes: Optional[list[str]] = None
    observacao: Optional[str] = None


class DemandaEstoqueLiberar(BaseModel):
    """Estoque chegou — devolve o card ao fluxo normal."""
    observacao: Optional[str] = None


class ConsumoEmpenhoCreate(BaseModel):
    """Comunicado de uso que consome saldo de um empenho."""
    numero_pedido: str
    numero_nf: str
    valor_nf: float
    data_faturamento: Optional[date] = None
    canal: Optional[str] = None
    observacoes: Optional[str] = None
    itens: list[ItemPedidoCreate] = []
    af: Optional[str] = None
    nome_paciente: Optional[str] = None
    prontuario: Optional[str] = None
    data_procedimento: Optional[date] = None

    @field_validator("numero_pedido", "numero_nf")
    @classmethod
    def _strip_identificadores(cls, v: str) -> str:
        return v.strip() if v else v


# ── Painel de Demandas de Licitação ─────────────────────────────────────────────
class DemandaItem(BaseModel):
    """Item preliminar capturado no e-mail (opcional na triagem)."""
    produto_id: Optional[UUID] = None
    codigo: Optional[str] = None
    descricao: Optional[str] = None
    qtd: float = 0
    valor: float = 0


class NotaComunicado(BaseModel):
    """Uma nota fiscal do comunicado de uso, com o que ela cobre.

    A AF é uma; as notas são várias. O e-mail da licitação chega literalmente
    assim: "NF 20476 e NF 20480, referente ao comunicado de uso 57048". Cada nota
    tem itens e quantidades próprios, então o valor de cada uma sai dos seus
    itens — não de um total digitado à mão, que ninguém consegue conferir depois.
    """
    numero_nf: str
    numero_pedido: Optional[str] = None   # a OV; só existe quando a nota é lançada
    itens: list[DemandaItem] = []

    @field_validator("numero_nf")
    @classmethod
    def _nf_limpa(cls, v: str) -> str:
        limpo = (v or "").strip()
        if not limpo:
            raise ValueError("Informe o número da NF.")
        return limpo

    @property
    def valor(self) -> float:
        """Σ qtd × valor unitário dos itens desta nota."""
        return round(sum(float(i.qtd or 0) * float(i.valor or 0) for i in self.itens), 2)


class DemandaCreate(BaseModel):
    tipo_operacao: str            # VENDA_DIRETA | CONSIGNACAO | COMUNICADO_USO
    numero_pregao: Optional[str] = None  # pregão (mestre) — rege o contrato
    numero: Optional[str] = None         # NE / referência; no COMUNICADO_USO é a AF
    cliente_id: UUID
    canal: Optional[str] = None
    prazo: Optional[date] = None
    prioridade: str = "NORMAL"
    observacao: Optional[str] = None
    itens: list[DemandaItem] = []
    # Regem o comunicado de uso — identificam o que foi usado, em qual paciente e quando.
    nome_paciente: Optional[str] = None
    prontuario: Optional[str] = None
    numero_nf: Optional[str] = None
    data_procedimento: Optional[date] = None
    # As notas da AF. `numero_nf` acima continua aceito (uma nota só) para não
    # quebrar quem já chama a API assim; o serviço converte para uma nota.
    notas: list[NotaComunicado] = []


class DemandaUpdate(BaseModel):
    tipo_operacao: Optional[str] = None
    etapa: Optional[str] = None
    numero_pregao: Optional[str] = None
    numero: Optional[str] = None
    cliente_id: Optional[UUID] = None
    canal: Optional[str] = None
    prazo: Optional[date] = None
    prioridade: Optional[str] = None
    observacao: Optional[str] = None
    responsavel_id: Optional[UUID] = None
    ref_externa: Optional[str] = None
    itens: Optional[list[DemandaItem]] = None
    nome_paciente: Optional[str] = None
    prontuario: Optional[str] = None
    numero_nf: Optional[str] = None
    data_procedimento: Optional[date] = None
    notas: Optional[list[NotaComunicado]] = None


class DemandaConcluir(BaseModel):
    """Dados para gerar o artefato ao concluir a demanda.

    Os campos usados dependem do tipo de operação da demanda:
    - VENDA_DIRETA → cria OV (numero_pedido, tipo_frete, data_prevista_entrega, itens)
    - CONSIGNACAO → cria empenho (numero, vigencia, data_empenho, itens com valor)
    - COMUNICADO_USO → registra comunicado (numero_pedido, numero_nf, valor_nf; empenho_id opcional)
    """
    numero: Optional[str] = None
    numero_pregao: Optional[str] = None  # nº do pregão (licitação), separado do nº do contrato/empenho
    numero_pedido: Optional[str] = None
    tipo_frete: Optional[str] = None
    data_prevista_entrega: Optional[date] = None
    local_entrega: Optional[str] = None
    # Só usada no atalho "gerar a OV junto" (venda direta) — nos outros tipos a
    # conclusão não cria OV. Exigida no serviço, onde se sabe se há OV em jogo.
    condicao_pagamento: Optional[str] = None
    vigencia: Optional[date] = None
    data_empenho: Optional[date] = None
    numero_nf: Optional[str] = None
    valor_nf: Optional[float] = None
    data_faturamento: Optional[date] = None
    empenho_id: Optional[UUID] = None
    canal: Optional[str] = None
    # Cliente confirmado ao concluir (obrigatório no comunicado de uso) — garante
    # que o faturamento entra no sistema com o cliente certo.
    cliente_id: Optional[UUID] = None
    # Regem o comunicado de uso (AF vem em `numero`) — confirmados/editados na conclusão.
    nome_paciente: Optional[str] = None
    prontuario: Optional[str] = None
    data_procedimento: Optional[date] = None
    # Atalho de entrega única (venda direta): ao criar o contrato, já gera a OV
    # cheia baixando todo o saldo (usa numero_pedido como nº da OV).
    gerar_ov: bool = False
    itens: list[DemandaItem] = []
    # Comunicado de uso com varias notas: cada nota vira um lancamento proprio
    # (pedidos.numero_nf e unico, e o faturamento conta por lancamento). Quando
    # vem vazia, `numero_nf`/`valor_nf`/`itens` acima valem como a nota unica.
    notas: list[NotaComunicado] = []


# ── CRM ──────────────────────────────────────────────────────────────────────────
class ClienteRapidoCreate(BaseModel):
    """Cadastro de cliente/prospect direto do CRM (comercial). O código é
    gerado automaticamente — o cliente ainda não está no D365."""
    nome: str
    cnpj: Optional[str] = None


class ContatoCreate(BaseModel):
    nome: str
    cargo: Optional[str] = None
    email: Optional[str] = None
    telefone: Optional[str] = None
    cliente_id: Optional[UUID] = None
    canal: Optional[str] = None
    observacao: Optional[str] = None


class ContatoUpdate(BaseModel):
    nome: Optional[str] = None
    cargo: Optional[str] = None
    email: Optional[str] = None
    telefone: Optional[str] = None
    cliente_id: Optional[UUID] = None
    canal: Optional[str] = None
    observacao: Optional[str] = None


class OportunidadeItem(BaseModel):
    produto_id: Optional[UUID] = None
    codigo: Optional[str] = None
    descricao: Optional[str] = None
    qtd: float = 0
    valor_unitario: float = 0


class OportunidadeCreate(BaseModel):
    titulo: str
    cliente_id: Optional[UUID] = None
    contato_id: Optional[UUID] = None
    # A linha comercial sai dos itens; o que se pergunta é direta ou licitação.
    # `canal` segue aceito para compatibilidade e é derivado quando há itens.
    forma_venda: Optional[FormaVenda] = None
    canal: Optional[str] = None
    # O funil começa em QUALIFICACAO: o estágio LEAD duplicava o status do lead.
    estagio: str = "QUALIFICACAO"
    valor_estimado: Optional[float] = None
    probabilidade: Optional[int] = None
    origem: Optional[str] = None
    previsao_fechamento: Optional[date] = None
    proximo_passo: Optional[str] = None
    proximo_passo_em: Optional[date] = None
    itens: list[OportunidadeItem] = []


class OportunidadeUpdate(BaseModel):
    titulo: Optional[str] = None
    cliente_id: Optional[UUID] = None
    contato_id: Optional[UUID] = None
    forma_venda: Optional[FormaVenda] = None
    canal: Optional[str] = None
    estagio: Optional[str] = None
    valor_estimado: Optional[float] = None
    probabilidade: Optional[int] = None
    origem: Optional[str] = None
    previsao_fechamento: Optional[date] = None
    proximo_passo: Optional[str] = None
    proximo_passo_em: Optional[date] = None
    custo_estimado: Optional[float] = None
    itens: Optional[list[OportunidadeItem]] = None


class PerderRequest(BaseModel):
    """Perda estruturada: `codigo` é o que permite aprender por que perdemos.
    O texto livre continua, como complemento."""
    codigo: Optional[str] = None
    motivo: Optional[str] = None
    concorrente: Optional[str] = None
    preco_vencedor: Optional[float] = None


class GanharRequest(DecisaoEstoqueMixin):
    """Ganhar abre o repasse para operações de vendas. `repasse_nota` é o recado
    que hoje vai por mensagem de Teams — opcional, mas é onde cabe o que foi
    combinado com o cliente e não tem campo próprio.

    Herda a decisão de estoque: quando falta material o app responde 409 e o
    comercial reenvia o ganho já com `decisao_estoque` preenchida."""
    repasse_nota: Optional[str] = None


class AtividadeCreate(BaseModel):
    oportunidade_id: Optional[UUID] = None
    contato_id: Optional[UUID] = None
    cliente_id: Optional[UUID] = None
    tipo: str = "TAREFA"
    titulo: str
    descricao: Optional[str] = None
    data_hora: Optional[datetime] = None


class AtividadeUpdate(BaseModel):
    tipo: Optional[str] = None
    titulo: Optional[str] = None
    descricao: Optional[str] = None
    data_hora: Optional[datetime] = None
    concluida: Optional[bool] = None


class NotaCreate(BaseModel):
    texto: str


class GerarOVRequest(CondicaoPagamentoMixin):
    numero_pedido: str

    @field_validator("numero_pedido")
    @classmethod
    def _numero_ov(cls, v: str) -> str:
        return validar_numero_ov(v)
    tipo_frete: str = "FOB"
    data_prevista_entrega: date
    local_entrega: Optional[str] = None
    # Herdado da oportunidade quando não vem preenchido.
    forma_venda: Optional[FormaVenda] = None


class DisponibilidadeItem(BaseModel):
    produto_id: Optional[UUID] = None
    codigo: Optional[str] = None
    descricao: Optional[str] = None
    qtd: float = 0
    valor_unitario: float = 0


class DisponibilidadeRequest(BaseModel):
    """Consulta de estoque para itens que ainda não foram gravados em lugar
    nenhum — o formulário pergunta enquanto o comercial digita."""
    itens: list[DisponibilidadeItem] = []


class DevolverAoCrmRequest(BaseModel):
    """Devolve a OV ao comercial na etapa escolhida do funil. A etapa é obrigatória
    porque só quem devolve sabe em que ponto a venda voltou a ser negociação."""
    estagio: str
    motivo: Optional[str] = None


class ItemLiberacao(BaseModel):
    """Quanto de um item o comercial escolheu liberar agora."""
    produto_id: UUID
    qtd: float


class ItemFilaPendencia(BaseModel):
    fonte: str
    id: UUID


class ReordenarFilaRequest(BaseModel):
    """A fila de material inteira, de cima para baixo.

    Manda a lista completa em vez de "sobe um" porque a ordem é global: com dois
    operadores mexendo, incrementos brigam entre si e a fila fica num estado que
    nenhum dos dois pediu. A lista inteira é o que a pessoa está vendo na tela.
    """
    ordem: list[ItemFilaPendencia] = []


class AjusteEstoqueRequest(BaseModel):
    """Correção manual do PA da foto de hoje. O motivo é obrigatório: ajuste sem
    motivo não se audita, e este número destrava OV."""
    codigo: str
    estoque_pa: float
    motivo: str

    @field_validator("codigo")
    @classmethod
    def _cod(cls, v: str) -> str:
        if not (v or "").strip():
            raise ValueError("Informe o código do item.")
        return v.strip().upper()

    @field_validator("motivo")
    @classmethod
    def _motivo(cls, v: str) -> str:
        if len((v or "").strip()) < 5:
            raise ValueError("Explique o motivo do ajuste (mín. 5 caracteres).")
        return v.strip()

    @field_validator("estoque_pa")
    @classmethod
    def _qtd(cls, v: float) -> float:
        if v < 0:
            raise ValueError("A quantidade em estoque não pode ser negativa.")
        return v


class AcompanharPendenciaRequest(BaseModel):
    """Cobrança registrada numa pendência aberta: o que o PCP respondeu e para
    quando. Não libera material — só grava o que se sabe da espera."""
    previsao_pcp: Optional[date] = None
    observacao: Optional[str] = None
    # Previsão que não se cumpriu e não tem nova data: apagar é informação, e
    # `previsao_pcp=None` não distingue "não mexe" de "tira".
    limpar_previsao: bool = False


class ItemDevolverPendencia(BaseModel):
    codigo: str
    qtd: float


class DevolverPendenciaRequest(BaseModel):
    """Manda a OV de volta para a pendência do comercial.

    `itens` ausente devolve a OV INTEIRA — é o caso "total". Uma lista devolve
    só as quantidades escolhidas.
    """
    itens: Optional[list[ItemDevolverPendencia]] = None
    observacao: Optional[str] = None


class ItemAjustePendencia(BaseModel):
    """Item que entra numa pendência aberta. Código e descrição NÃO vêm daqui —
    o serviço lê do cadastro pelo produto_id, para não gravar dois nomes do
    mesmo produto."""
    produto_id: UUID
    qtd: float
    valor_unitario: float = 0


class AjustarItensPendenciaRequest(BaseModel):
    """Corrige o que está prometido numa pendência: inclui o que faltou no
    lançamento, remove o que entrou por engano.

    `remover` são produto_id, não índices de linha: índice muda quando a lista
    se reordena, e remover o item errado de uma venda é caro.
    """
    adicionar: Optional[list[ItemAjustePendencia]] = None
    remover: Optional[list[UUID]] = None
    observacao: Optional[str] = None


class LiberarPendenciaRequest(BaseModel):
    # Libera só o que já chegou e mantém o resto pendente. Sem isso, uma
    # pendência de 8 unidades com 5 prontas ficaria travada esperando as 3.
    parcial: bool = False
    observacao: Optional[str] = None
    # Quantidade escolhida item a item. Sem esta lista, libera tudo o que houver
    # em estoque — que era o único comportamento possível antes. Com ela, quem
    # decide é o comercial: dá para segurar um item para mandar tudo junto, ou
    # soltar só o que o cliente precisa agora.
    itens: Optional[list[ItemLiberacao]] = None


# ── CRM · Empresas (prospecção e qualificação) ─────────────────────────────────
# Blocos da qualificação. São objetos (e não campos soltos) porque a regra é
# "o bloco está completo ou não está" — o portão avalia o conjunto.
class QualNecessidade(BaseModel):
    """O que a empresa compra e quanto por mês."""
    familia: Optional[str] = None
    codigos: list[str] = []
    consumo_mes: Optional[float] = None
    unidade: Optional[str] = None
    # Usado só quando nenhum código é reconhecido e não há preço de referência.
    valor_mensal_estimado: Optional[float] = None
    observacao: Optional[str] = None


class QualDecisor(BaseModel):
    """Quem assina a compra. `papel` vem de crm_empresas_service.PAPEIS."""
    nome: Optional[str] = None
    papel: Optional[str] = None
    email: Optional[str] = None
    telefone: Optional[str] = None


class QualPrazo(BaseModel):
    """Quando compra: data firme ou janela. `tipo`: DATA | JANELA."""
    tipo: Optional[str] = None
    data: Optional[date] = None
    janela: Optional[str] = None


class QualVerba(BaseModel):
    """Não obrigatória para qualificar, mas pesa no score quando confirmada."""
    confirmada: Optional[bool] = None
    valor: Optional[float] = None
    observacao: Optional[str] = None


class Qualificacao(BaseModel):
    """A qualificação inteira. Guardada como jsonb na empresa e arquivada em
    crm_qualificacao_historico quando a empresa volta a prospectada."""
    necessidade: Optional[QualNecessidade] = None
    decisor: Optional[QualDecisor] = None
    prazo: Optional[QualPrazo] = None
    verba: Optional[QualVerba] = None


class EmpresaCreate(BaseModel):
    """Prospecção: só identificação e porte. O resto vem na qualificação."""
    razao_social: str
    cnpj: Optional[str] = None
    nome_fantasia: Optional[str] = None
    cidade: Optional[str] = None
    uf: Optional[str] = None
    tipo: Optional[str] = None
    porte: Optional[str] = None
    canal: Optional[str] = None
    fonte: Optional[str] = None
    cliente_id: Optional[UUID] = None
    observacao: Optional[str] = None
    qualificacao: Optional[Qualificacao] = None


class EmpresaUpdate(BaseModel):
    razao_social: Optional[str] = None
    cnpj: Optional[str] = None
    nome_fantasia: Optional[str] = None
    cidade: Optional[str] = None
    uf: Optional[str] = None
    tipo: Optional[str] = None
    porte: Optional[str] = None
    canal: Optional[str] = None
    fonte: Optional[str] = None
    cliente_id: Optional[UUID] = None
    observacao: Optional[str] = None
    estado: Optional[str] = None
    qualificacao: Optional[Qualificacao] = None
    motivo_descarte: Optional[str] = None
    motivo_descarte_codigo: Optional[str] = None
    proximo_passo: Optional[str] = None
    proximo_passo_em: Optional[date] = None


class EmpresaContatoRequest(BaseModel):
    """Registro de uma interação — é movimentação real e zera o relógio do ciclo."""
    tipo: Optional[str] = None
    descricao: Optional[str] = None
    proximo_passo: Optional[str] = None
    proximo_passo_em: Optional[date] = None


# ── CRM · Desafios ─────────────────────────────────────────────────────────────
class DesafioCreate(BaseModel):
    """`tipo_id` escolhe um tipo existente; `tipo_texto` cria um novo a partir do
    que o operador escreveu (o sistema normaliza e reaproveita)."""
    tipo_id: Optional[UUID] = None
    tipo_texto: Optional[str] = None
    descricao: Optional[str] = None
    bloqueia: Optional[bool] = None
    responsavel_id: Optional[UUID] = None
    prazo: Optional[date] = None


class DesafioUpdate(BaseModel):
    descricao: Optional[str] = None
    bloqueia: Optional[bool] = None
    status: Optional[str] = None
    responsavel_id: Optional[UUID] = None
    prazo: Optional[date] = None
    resolucao: Optional[str] = None


# ── CRM · Cotações ────────────────────────────────────────────────────────────────
class CotacaoItem(BaseModel):
    produto_id: Optional[UUID] = None
    codigo: Optional[str] = None
    descricao: Optional[str] = None
    qtd: float = 0
    valor_unitario: float = 0
    desconto_pct: float = 0


class CotacaoCreate(BaseModel):
    numero: Optional[str] = None
    cliente_id: Optional[UUID] = None
    contato_id: Optional[UUID] = None
    oportunidade_id: Optional[UUID] = None
    forma_venda: Optional[FormaVenda] = None
    canal: Optional[str] = None
    validade: Optional[date] = None
    condicao_pagamento: Optional[str] = None
    prazo_entrega: Optional[str] = None
    frete: float = 0
    desconto_pct: float = 0
    observacao: Optional[str] = None
    cliente_cnpj: Optional[str] = None
    contato_nome: Optional[str] = None
    contato_email: Optional[str] = None
    endereco: Optional[str] = None
    endereco_bairro: Optional[str] = None
    endereco_cidade: Optional[str] = None
    endereco_uf: Optional[str] = None
    endereco_cep: Optional[str] = None
    itens: list[CotacaoItem] = []


class CotacaoUpdate(BaseModel):
    numero: Optional[str] = None
    cliente_id: Optional[UUID] = None
    contato_id: Optional[UUID] = None
    forma_venda: Optional[FormaVenda] = None
    canal: Optional[str] = None
    validade: Optional[date] = None
    condicao_pagamento: Optional[str] = None
    prazo_entrega: Optional[str] = None
    frete: Optional[float] = None
    desconto_pct: Optional[float] = None
    observacao: Optional[str] = None
    status: Optional[str] = None
    cliente_cnpj: Optional[str] = None
    contato_nome: Optional[str] = None
    contato_email: Optional[str] = None
    endereco: Optional[str] = None
    endereco_bairro: Optional[str] = None
    endereco_cidade: Optional[str] = None
    endereco_uf: Optional[str] = None
    endereco_cep: Optional[str] = None
    itens: Optional[list[CotacaoItem]] = None


class MetaFaturamentoRequest(BaseModel):
    competencia: str  # 'YYYY-MM'
    canal: str        # URO | VASCULAR | REALCLOSURE | LICITACAO
    valor: float


class PedidoOut(BaseModel):
    id: UUID
    numero_pedido: str
    cliente_id: UUID
    transportadora_id: Optional[UUID]
    status: StatusPedido
    prioridade: Prioridade
    data_prevista_entrega: date
    data_prevista_coleta: Optional[date]
    data_real_coleta: Optional[datetime]
    numero_nf: Optional[str]
    valor_nf: Optional[float]
    codigo_rastreio: Optional[str] = None
    tipo_operacao: Optional[TipoOperacao] = None
    canal: Optional[str] = None
    forma_venda: Optional[FormaVenda] = None
    observacoes: Optional[str]
    # Opcional na leitura: as OVs anteriores à exigência não têm o campo preenchido.
    condicao_pagamento: Optional[str] = None
    criado_em: datetime
    atualizado_em: datetime
    atrasado: bool = False
    cliente: Optional[ClienteOut] = None
    transportadora: Optional[TransportadoraOut] = None
    itens: list[ItemPedidoOut] = []


class PedidoListOut(BaseModel):
    """Versão resumida para listagens — sem itens detalhados."""
    id: UUID
    numero_pedido: str
    status: StatusPedido
    prioridade: Prioridade
    data_prevista_entrega: date
    atrasado: bool
    cliente_nome: str
    transportadora_nome: Optional[str]


class AlterarStatusRequest(BaseModel):
    novo_status: StatusPedido
    observacao: Optional[str] = None


class BloquearPedidoRequest(BaseModel):
    motivo: str


# ── Separação ─────────────────────────────────────────────────────────────────

class IniciarSeparacaoRequest(BaseModel):
    pedido_id: UUID


class FinalizarSeparacaoRequest(BaseModel):
    itens: list[dict]  # [{item_id, qtd_separada, lote_id?}]
    observacao: Optional[str] = None


class SeparacaoOut(BaseModel):
    id: UUID
    pedido_id: UUID
    operador_id: UUID
    inicio: datetime
    fim: Optional[datetime]
    lead_time_min: Optional[float]
    observacao: Optional[str]


# ── Conferência ───────────────────────────────────────────────────────────────

class IniciarConferenciaRequest(BaseModel):
    pedido_id: UUID


class FinalizarConferenciaRequest(BaseModel):
    resultado: ResultadoConferencia
    itens_conferidos: list[dict]  # [{item_id, qtd_conferida, qtd_divergente?, tipo_divergencia?}]
    observacao: Optional[str] = None


class ConferenciaOut(BaseModel):
    id: UUID
    pedido_id: UUID
    conferente_id: UUID
    resultado: ResultadoConferencia
    inicio: datetime
    fim: Optional[datetime]
    lead_time_min: Optional[float]
    observacao: Optional[str]


# ── Tratativa de Divergência ──────────────────────────────────────────────────

class TratativaRequest(BaseModel):
    decisao: DecisaoTratativa
    justificativa: str
    retrabalho: bool = False
    tempo_retrabalho_min: Optional[int] = None


# ── Previsão de Faturamento (negócios em negociação) ────────────────────────────

class PrevisaoNegocioCreate(BaseModel):
    cliente_id: Optional[UUID] = None
    cliente_nome: Optional[str] = None
    descricao: Optional[str] = None
    valor: float = 0
    probabilidade: int = 50          # 0..100
    previsao_fechamento: Optional[date] = None
    canal: Optional[str] = None
    observacao: Optional[str] = None


class PrevisaoNegocioUpdate(BaseModel):
    cliente_id: Optional[UUID] = None
    cliente_nome: Optional[str] = None
    descricao: Optional[str] = None
    valor: Optional[float] = None
    probabilidade: Optional[int] = None
    previsao_fechamento: Optional[date] = None
    canal: Optional[str] = None
    observacao: Optional[str] = None
    status: Optional[str] = None      # ABERTO | GANHO | PERDIDO


# ── Cotação de frete (CIF, antes do faturamento) ────────────────────────────────

class CotacaoFreteRequest(BaseModel):
    valor_frete: Optional[float] = None       # valor cotado do frete
    transportadora_id: Optional[UUID] = None  # transportadora cotada (opcional)
    observacao: Optional[str] = None
    # Data prevista de entrega confirmada por Op. Vendas neste momento (a data
    # da criação era só a esperada pelo cliente).
    data_prevista_entrega: Optional[date] = None


class TransportadoraClienteRequest(BaseModel):
    """FOB: o cliente informa qual transportadora vai coletar (vai na NF).
    Op. Vendas registra e a OV segue para faturamento."""
    transportadora_id: UUID
    transportadora_nome_real: Optional[str] = None  # quando "OUTROS"
    observacao: Optional[str] = None
    # Data prevista de entrega confirmada por Op. Vendas neste momento.
    data_prevista_entrega: Optional[date] = None


# ── Faturamento ───────────────────────────────────────────────────────────────

class FaturamentoRequest(BaseModel):
    numero_nf: str
    valor_nf: Optional[float] = None
    valor_produtos: Optional[float] = None  # CIF: valor só dos produtos
    valor_frete: Optional[float] = None     # CIF: custo do frete separado
    chave_nfe: Optional[str] = None
    data_prevista_entrega: Optional[date] = None  # permite corrigir a data ao registrar NF
    codigo_rastreio: Optional[str] = None  # só Correios


# ── Coleta ────────────────────────────────────────────────────────────────────

class AgendarColetaRequest(BaseModel):
    transportadora_id: UUID
    data_prevista_coleta: date


class ConfirmarColetaRequest(BaseModel):
    data_real_coleta: datetime
    motorista: Optional[str] = None
    placa: Optional[str] = None
    protocolo: Optional[str] = None


# ── Ocorrência ────────────────────────────────────────────────────────────────

class OcorrenciaCreate(BaseModel):
    pedido_id: str  # Aceita UUID ou número da OV (ex: OV015406)
    tipo: str
    descricao: str


class OcorrenciaFechar(BaseModel):
    resolucao: str


class OcorrenciaOut(BaseModel):
    id: UUID
    pedido_id: UUID
    tipo: str
    descricao: str
    responsavel_id: UUID
    status: StatusOcorrencia
    resolucao: Optional[str]
    criado_em: datetime
    resolvido_em: Optional[datetime]


# ── Movimentação ──────────────────────────────────────────────────────────────

class MovimentacaoOut(BaseModel):
    id: UUID
    pedido_id: UUID
    status_anterior: Optional[str]
    status_novo: str
    usuario_id: UUID
    observacao: Optional[str]
    criado_em: datetime


# ── Dashboard ─────────────────────────────────────────────────────────────────

class ResumoStatusOut(BaseModel):
    status: str
    quantidade: int
    atrasados: int


class DashboardOperacionalOut(BaseModel):
    data: date
    total_pedidos: int
    expedidos_hoje: int
    atrasados: int
    por_status: list[ResumoStatusOut]
    ocorrencias_abertas: int


class IndicadoresOut(BaseModel):
    otif: float
    taxa_divergencia: float
    taxa_retrabalho: float
    lead_time_medio_horas: float
    pedidos_expedidos: int
    backlog: int
    aderencia_cutoff: Optional[float]


# ── Inventário Contínuo ───────────────────────────────────────

class InventarioItemCreate(BaseModel):
    codigo_item: str
    lote: str
    qtd_sistemico: float
    qtd_fisico: Optional[float] = None
    qtd_venda: float
    observacao: Optional[str] = None


class InventarioItemOut(BaseModel):
    id: UUID
    pedido_id: UUID
    codigo_item: str
    lote: str
    qtd_sistemico: float
    qtd_fisico: Optional[float]
    qtd_venda: float
    qtd_estoque: Optional[float]
    status_item: str
    observacao: Optional[str]


class InventarioSalvar(BaseModel):
    itens: list[InventarioItemCreate]


class VerificarFisicoRequest(BaseModel):
    itens_verificados: list[dict]  # [{id, qtd_fisico, status_item, observacao?}]


# ── Cubagem ───────────────────────────────────────────────────

class CubagemItemCreate(BaseModel):
    tipo_caixa_id: Optional[str] = None
    tipo_caixa_nome: str
    quantidade: int = 1


class CubagemCreate(BaseModel):
    peso_kg: Optional[float] = None
    altura_cm: Optional[float] = None
    largura_cm: Optional[float] = None
    comprimento_cm: Optional[float] = None
    num_caixas: Optional[int] = None
    observacao: Optional[str] = None
    itens: list[CubagemItemCreate] = []


class CubagemOut(BaseModel):
    id: UUID
    pedido_id: UUID
    peso_kg: Optional[float]
    altura_cm: Optional[float]
    largura_cm: Optional[float]
    comprimento_cm: Optional[float]
    num_caixas: Optional[int]
    observacao: Optional[str]
    criado_em: datetime


# ── Pallets ───────────────────────────────────────────────────

class PalletCreate(BaseModel):
    transportadora_id: UUID
    data_prevista_coleta: Optional[date] = None
    observacao: Optional[str] = None


class PalletOut(BaseModel):
    id: UUID
    codigo: str
    transportadora_id: Optional[UUID]
    status: str
    data_prevista_coleta: Optional[date]
    data_real_coleta: Optional[datetime]
    observacao: Optional[str]
    criado_em: datetime
    pedidos: list[dict] = []


class AdicionarPedidoPalletRequest(BaseModel):
    pedido_id: str  # Aceita número de OV (OV015374) ou UUID
    num_caixas: Optional[int] = None
    observacao: Optional[str] = None  # Transportadora para PLT-OUTROS


# ── Importação CSV ────────────────────────────────────────────────────────────

class ImportacaoResultado(BaseModel):
    total: int
    importados: int
    erros: list[dict]


# ── Inventário Contínuo ───────────────────────────────────────────────────────

class CicloCreate(BaseModel):
    nome: str
    data_abertura: date
    meta_itens: Optional[int] = None

class ContagemCreate(BaseModel):
    codigo_produto: str
    descricao_produto: Optional[str] = None
    lote: str
    qtd_sistemica: int
    qtd_fisica: int
    qtd_venda: int = 0
    motivo_id: Optional[str] = None
    observacao: Optional[str] = None
    operador_nome: Optional[str] = None  # sobrescreve o nome do usuário autenticado se informado

class RevisarContagemRequest(BaseModel):
    acao: str  # 'APROVAR' ou 'RECONTAGEM'
    instrucao_recontagem: Optional[str] = None


TokenResponse.model_rebuild()
