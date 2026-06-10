/**
 * Impressão de etiquetas Zebra TLP 2844
 * Tenta Browser Print (ZPL direto) e cai automaticamente para
 * impressão via navegador (window.print) se falhar.
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatarData(iso: string): string {
  const dt = new Date(iso)
  return [
    String(dt.getDate()).padStart(2, '0'),
    String(dt.getMonth() + 1).padStart(2, '0'),
    dt.getFullYear(),
  ].join('/')
}

// ── ZPL (Browser Print / raw TCP) ────────────────────────────────────────────

/** Gera ZPL para TLP 2844 — ASCII puro, layout idêntico ao modelo MSB */
function gerarZPL(dados: EtiquetaInventario): string {
  const val = dados.validade || '---'
  const data = formatarData(dados.dataInventario)
  return `^XA
^MMT
^PW812
^LL508
^LS0
^FO20,15^A0N,60,60^FDITEM: ${dados.codigo}^FS
^FO20,100^A0N,60,60^FDLOTE: ${dados.lote}^FS
^FO20,185^A0N,60,60^FDQNT: ${dados.quantidade} UNIDADES^FS
^FO20,270^A0N,60,60^FDVAL: ${val}^FS
^FO20,355^A0N,60,60^FDINVENTARIO: ${data}^FS
^XZ`
}

/** Verifica se o Zebra Browser Print está rodando */
export async function verificarZebraConectado(): Promise<boolean> {
  try {
    const resp = await fetch(`${ZEBRA_URL}/available`, {
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
 * Encontra a TLP 2844 — exclui ZD230 explicitamente.
 * Reconhece: '2844', 'tlp', 'zebra 01' (nome desta unidade no Browser Print).
 */
export async function encontrarTLP2844(): Promise<{ printer: any | null; erro?: string }> {
  const impressoras = await listarImpressoras()

  if (impressoras.length === 0) {
    return { printer: null, erro: 'Nenhuma impressora no Browser Print.' }
  }

  const tlp = impressoras.find(p => {
    const nome = (p?.name || '').toLowerCase()
    if (nome.includes('zd230')) return false   // nunca usar ZD230
    return (
      nome.includes('2844') ||
      nome.includes('tlp') ||
      nome.includes('zebra 01')
    )
  })

  if (!tlp) {
    const nomes = impressoras.map((p: any) => p?.name || '?').join(', ')
    return {
      printer: null,
      erro: `TLP 2844 nao encontrada. Visiveis: ${nomes}`,
    }
  }

  return { printer: tlp }
}

// ── Impressão via navegador (fallback) ───────────────────────────────────────

/**
 * Abre janela de impressão do navegador com a etiqueta formatada em HTML/CSS.
 * Usa o driver Windows (ZDesigner TLP 2844) — funciona mesmo sem Browser Print.
 */
export function imprimirEtiquetaNavegador(dados: EtiquetaInventario): void {
  const val = dados.validade || '---'
  const data = formatarData(dados.dataInventario)

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Etiqueta</title>
<style>
  @page { size: 4in 2.5in; margin: 4mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-weight: 900; }
  p { font-size: 18pt; line-height: 1.35; letter-spacing: -0.5px; }
</style>
</head>
<body>
  <p>ITEM: ${dados.codigo}</p>
  <p>LOTE: ${dados.lote}</p>
  <p>QNT: ${dados.quantidade} UNIDADES</p>
  <p>VAL: ${val}</p>
  <p>INVENTARIO: ${data}</p>
</body>
</html>`

  const w = window.open('', '_blank', 'width=500,height=380,toolbar=0,menubar=0')
  if (!w) return
  w.document.open()
  w.document.write(html)
  w.document.close()
  // Aguarda renderização e abre diálogo de impressão
  w.onload = () => {
    w.focus()
    setTimeout(() => { w.print() }, 300)
  }
}

// ── Principal ─────────────────────────────────────────────────────────────────

export type ResultadoImpressao = {
  ok: boolean
  metodo?: 'browser_print' | 'navegador'
  erro?: string
}

/**
 * Imprime etiqueta:
 * 1. Tenta Browser Print (ZPL direto na TLP 2844)
 * 2. Se falhar, cai automaticamente para window.print() via driver Windows
 */
export async function imprimirEtiqueta(
  dados: EtiquetaInventario,
  impressora?: any
): Promise<ResultadoImpressao> {
  // ── Tentativa 1: Browser Print ──
  try {
    const conectado = await verificarZebraConectado()

    if (conectado) {
      let printer = impressora
      if (!printer) {
        const { printer: tlp } = await encontrarTLP2844()
        printer = tlp
      }

      if (printer) {
        const zpl = gerarZPL(dados)
        const resp = await fetch(`${ZEBRA_URL}/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device: printer, data: zpl }),
        })

        if (resp.ok) {
          return { ok: true, metodo: 'browser_print' }
        }
        // 500 ou outro erro → cai para fallback
      }
    }
  } catch {
    // ignora e cai para fallback
  }

  // ── Tentativa 2: window.print() via driver Windows ──
  imprimirEtiquetaNavegador(dados)
  return { ok: true, metodo: 'navegador' }
}

/** URL de download do Zebra Browser Print */
export const ZEBRA_DOWNLOAD_URL =
  'https://www.zebra.com/us/en/support-downloads/software/utilities/zebra-browser-print-utility.html'
