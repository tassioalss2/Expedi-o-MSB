/**
 * Integração com Zebra Browser Print para Zebra TLP 2844
 * Requer Zebra Browser Print instalado: https://www.zebra.com/us/en/support-downloads/software/utilities/zebra-browser-print-utility.html
 */

const ZEBRA_URL = 'http://localhost:9100'

export interface EtiquetaInventario {
  codigo: string
  lote: string
  validade?: string
  quantidade: number
  ov: string
  dataInventario: string
  operador?: string
}

/** Gera ZPL para Zebra TLP 2844 (4" x 2.5", 203dpi)
 *  Layout idêntico ao modelo MSB:
 *    ITEM: UFGH-035150RHS
 *    LOTE: 000026-26-01
 *    QNT: 200 UNIDADES
 *    VAL: 03/2029
 *    INVENTÁRIO: 02/06/2026
 */
function gerarZPL(dados: EtiquetaInventario): string {
  const dt = new Date(dados.dataInventario)
  const dataFormatada = [
    String(dt.getDate()).padStart(2, '0'),
    String(dt.getMonth() + 1).padStart(2, '0'),
    dt.getFullYear(),
  ].join('/')

  // Validade: aceita MM/AAAA ou MM/YYYY — passa direto como digitado
  const val = dados.validade || '---'

  return `^XA
^CI28
^MMT
^PW812
^LL508
^LS0
^FO20,15^A0N,60,60^FDITEM: ${dados.codigo}^FS
^FO20,100^A0N,60,60^FDLOTE: ${dados.lote}^FS
^FO20,185^A0N,60,60^FDQNT: ${dados.quantidade} UNIDADES^FS
^FO20,270^A0N,60,60^FDVAL: ${val}^FS
^FO20,355^A0N,60,60^FDINVENTÁRIO: ${dataFormatada}^FS
^XZ`
}

/** Verifica se o Zebra Browser Print está rodando */
export async function verificarZebraConectado(): Promise<boolean> {
  try {
    const resp = await fetch(`${ZEBRA_URL}/available`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    })
    return resp.ok
  } catch {
    return false
  }
}

/** Lista todas as impressoras disponíveis no Browser Print */
export async function listarImpressoras(): Promise<any[]> {
  try {
    const resp = await fetch(`${ZEBRA_URL}/available`)
    if (!resp.ok) return []
    const data = await resp.json()
    return data?.printer || []
  } catch {
    return []
  }
}

/**
 * Encontra a TLP 2844 na lista de impressoras.
 * Busca pelo nome (case-insensitive) e NÃO usa fallback para outra impressora,
 * evitando imprimir na impressora errada (ex: ZD230).
 */
export async function encontrarTLP2844(): Promise<{ printer: any | null; erro?: string }> {
  const impressoras = await listarImpressoras()

  if (impressoras.length === 0) {
    return {
      printer: null,
      erro: 'Nenhuma impressora encontrada no Zebra Browser Print. Verifique se o serviço está rodando.',
    }
  }

  const tlp = impressoras.find(p => {
    const nome = (p?.name || '').toLowerCase()
    return nome.includes('2844') || nome.includes('tlp')
  })

  if (!tlp) {
    const nomes = impressoras.map((p: any) => p?.name || 'sem nome').join(', ')
    return {
      printer: null,
      erro: `TLP 2844 não encontrada no Browser Print. Impressoras visíveis: ${nomes}. Adicione a TLP 2844 em "Added Devices" no Browser Print.`,
    }
  }

  return { printer: tlp }
}

/** Imprime etiqueta na impressora TLP 2844 */
export async function imprimirEtiqueta(
  dados: EtiquetaInventario,
  impressora?: any
): Promise<{ ok: boolean; erro?: string }> {
  try {
    const conectado = await verificarZebraConectado()
    if (!conectado) {
      return {
        ok: false,
        erro: 'Zebra Browser Print não encontrado. Verifique se está instalado e rodando.',
      }
    }

    let printer = impressora
    if (!printer) {
      const { printer: tlp, erro } = await encontrarTLP2844()
      if (!tlp) return { ok: false, erro }
      printer = tlp
    }

    const zpl = gerarZPL(dados)

    const resp = await fetch(`${ZEBRA_URL}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: printer, data: zpl }),
    })

    if (!resp.ok) {
      return { ok: false, erro: `Erro ao enviar para impressora: ${resp.status}` }
    }

    return { ok: true }
  } catch (e: any) {
    return { ok: false, erro: e?.message || 'Erro desconhecido na impressão' }
  }
}

/** URL de download do Zebra Browser Print */
export const ZEBRA_DOWNLOAD_URL =
  'https://www.zebra.com/us/en/support-downloads/software/utilities/zebra-browser-print-utility.html'
