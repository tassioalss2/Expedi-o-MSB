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

/** Gera ZPL para Zebra TLP 2844 (4" x 2", 203dpi) */
function gerarZPL(dados: EtiquetaInventario): string {
  const dataFormatada = new Date(dados.dataInventario).toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })

  return `
^XA
^MMT
^PW812
^LL406
^LS0

^FO30,20^A0N,28,28^FDMSB Biomedical - Inventario^FS

^FO30,60^A0N,36,36^FD${dados.codigo}^FS

^FO30,105^A0N,24,24^FDLote: ${dados.lote}^FS

^FO30,135^A0N,24,24^FDValidade: ${dados.validade || '---'}^FS

^FO30,170^A0N,36,36^FDQTD: ${dados.quantidade}^FS

^FO30,215^A0N,20,20^FDOV: ${dados.ov}^FS
^FO30,240^A0N,20,20^FDData: ${dataFormatada}^FS

^FO420,60^BCN,80,Y,N,N^FD${dados.codigo}^FS

^FO30,275^GB752,3,3^FS
^FO30,283^A0N,18,18^FDInventario Continuo MSB^FS

^XZ`.trim()
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

/** Lista impressoras disponíveis */
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

/** Imprime etiqueta na impressora Zebra */
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
      const impressoras = await listarImpressoras()
      if (impressoras.length === 0) {
        return { ok: false, erro: 'Nenhuma impressora Zebra encontrada.' }
      }
      // Prioriza TLP 2844
      printer = impressoras.find(p =>
        p?.name?.toLowerCase().includes('2844') ||
        p?.name?.toLowerCase().includes('zebra')
      ) || impressoras[0]
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
