/**
 * Impressão de etiquetas Zebra TLP 2844
 * Tenta Browser Print (ZPL direto) e cai automaticamente para
 * impressão via navegador (window.print) se falhar.
 */

const ZEBRA_URL        = 'http://localhost:9100'   // Zebra Browser Print
const PRINT_AGENT_URL  = 'http://localhost:9095'   // MSB Print Agent

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

/**
 * Gera ZPL para TLP 2844 — 100mm × 60mm (800 × 480 dots @ 203dpi)
 * Layout idêntico ao modelo MSB — Arial Black 19.5pt ≈ 55 dots
 *   ITEM: {codigo}
 *   LOTE: {lote}
 *   VAL:  {validade}
 *   QNT:  {quantidade} UNIDADES
 *   Nome: {operador}
 *   INVENTARIO: {data}
 */
function gerarZPL(dados: EtiquetaInventario): string {
  const val  = dados.validade  || '---'
  const data = formatarData(dados.dataInventario)
  const nome = dados.operador  || ''

  // 6 linhas × 77 dots espaçamento, fonte 55 dots (~19.5pt @ 203dpi)
  return `^XA
^MMT
^PW800
^LL480
^LS0
^FO8,5^A0N,55,55^FDITEM: ${dados.codigo}^FS
^FO8,82^A0N,55,55^FDLOTE: ${dados.lote}^FS
^FO8,159^A0N,55,55^FDVAL: ${val}^FS
^FO8,236^A0N,55,55^FDQNT: ${dados.quantidade} UNIDADES^FS
^FO8,313^A0N,55,55^FDNome: ${nome}^FS
^FO8,390^A0N,55,55^FDINVENTARIO: ${data}^FS
^XZ`
}

/** Verifica se o MSB Print Agent está rodando (localhost:9095) */
export async function verificarPrintAgent(): Promise<boolean> {
  try {
    const resp = await fetch(`${PRINT_AGENT_URL}/status`, {
      signal: AbortSignal.timeout(1500),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Verifica se QUALQUER método de impressão automática está disponível.
 * Testa PrintAgent primeiro, depois Browser Print.
 */
export async function verificarZebraConectado(): Promise<boolean> {
  if (await verificarPrintAgent()) return true
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

  const nome = dados.operador || ''

  // 100mm × 60mm — 6 linhas, Arial Black 19pt
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Etiqueta</title>
<style>
  @page { size: 100mm 60mm; margin: 2mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Arial Black', Arial, sans-serif; font-weight: 900; }
  p { font-size: 19pt; line-height: 1.28; white-space: nowrap; }
</style>
</head>
<body>
  <p>ITEM: ${dados.codigo}</p>
  <p>LOTE: ${dados.lote}</p>
  <p>VAL: ${val}</p>
  <p>QNT: ${dados.quantidade} UNIDADES</p>
  <p>Nome: ${nome}</p>
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
  metodo?: 'browser_print' | 'print_agent' | 'navegador'
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
  const zpl = gerarZPL(dados)

  // ── Tentativa 1: MSB Print Agent (localhost:9095) — usa GDI, sem conflito ZPL ──
  try {
    const agentOk = await verificarPrintAgent()
    if (agentOk) {
      const resp = await fetch(`${PRINT_AGENT_URL}/print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codigo:          dados.codigo,
          lote:            dados.lote,
          validade:        dados.validade || '---',
          quantidade:      dados.quantidade,
          operador:        dados.operador || '',
          data_inventario: dados.dataInventario,
        }),
      })
      if (resp.ok) return { ok: true, metodo: 'print_agent' }
    }
  } catch { /* cai para próxima tentativa */ }

  // ── Tentativa 2: Browser Print (localhost:9100) ──
  try {
    const conectado = await fetch(`${ZEBRA_URL}/available`, {
      signal: AbortSignal.timeout(2000),
    }).then(r => r.ok).catch(() => false)

    if (conectado) {
      let printer = impressora
      if (!printer) {
        const { printer: tlp } = await encontrarTLP2844()
        printer = tlp
      }
      if (printer) {
        const resp = await fetch(`${ZEBRA_URL}/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device: printer, data: zpl }),
        })
        if (resp.ok) return { ok: true, metodo: 'browser_print' }
      }
    }
  } catch { /* cai para fallback */ }

  // ── Tentativa 3: window.print() via driver Windows ──
  imprimirEtiquetaNavegador(dados)
  return { ok: true, metodo: 'navegador' }
}

/** URL de download do Zebra Browser Print */
export const ZEBRA_DOWNLOAD_URL =
  'https://www.zebra.com/us/en/support-downloads/software/utilities/zebra-browser-print-utility.html'
