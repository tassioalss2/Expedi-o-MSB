"""
MSB Print Agent v2.0
====================
Agente local de impressao para Zebra TLP 2844.
Usa GDI do Windows (driver ZDesigner) — sem conflito com configuracoes da impressora.

Uso:
  python print_agent.py

Porta: http://localhost:9095
"""

import json
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

# ── Verificar pywin32 ─────────────────────────────────────────────────────────
try:
    import win32print
    import win32ui
    import win32con
except ImportError:
    print("\n" + "="*55)
    print("  ERRO: pywin32 nao instalado!")
    print("  Execute: pip install pywin32")
    print("="*55 + "\n")
    input("Pressione ENTER para sair...")
    sys.exit(1)

PORT = 9095


# ── Utilitarios ───────────────────────────────────────────────────────────────

def encontrar_tlp2844() -> str | None:
    """Busca a TLP 2844 nas impressoras instaladas no Windows."""
    try:
        impressoras = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS,
            None, 2
        )
        # Primeira passagem: busca 2844 ou TLP
        for p in impressoras:
            nome = p['pPrinterName'].lower()
            if '2844' in nome or ('tlp' in nome and 'zebra' in nome):
                return p['pPrinterName']
        # Segunda passagem: qualquer ZDesigner/Zebra que nao seja ZD230
        for p in impressoras:
            nome = p['pPrinterName'].lower()
            if 'zd230' in nome:
                continue
            if 'zdesigner' in nome or 'zebra' in nome:
                return p['pPrinterName']
    except Exception as e:
        print(f"  Erro ao listar impressoras: {e}")
    return None


def formatar_data(iso: str) -> str:
    """Converte ISO para DD/MM/YYYY."""
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        return dt.strftime('%d/%m/%Y')
    except Exception:
        return iso[:10] if len(iso) >= 10 else iso


def imprimir_gdi(dados: dict, nome_impressora: str) -> None:
    """
    Imprime etiqueta via GDI usando o driver ZDesigner.
    O driver ja tem a etiqueta configurada (100mm x 60mm, gap 3mm) —
    o paper feed e feito corretamente pelo driver, sem conflito de ZPL.
    """
    hdc = win32ui.CreateDC()
    hdc.CreatePrinterDC(nome_impressora)

    dpi_x = hdc.GetDeviceCaps(win32con.LOGPIXELSX)
    dpi_y = hdc.GetDeviceCaps(win32con.LOGPIXELSY)

    def mm_x(mm): return int(mm * dpi_x / 25.4)
    def mm_y(mm): return int(mm * dpi_y / 25.4)

    # Fonte Arial Black 19.5pt (negativo = altura em pixels)
    font_h = -int(19.5 * dpi_y / 72)
    font = win32ui.CreateFont({
        'name': 'Arial',
        'height': font_h,
        'weight': 900,          # FW_BLACK (mais grosso que FW_BOLD=700)
        'charset': 0,           # ANSI_CHARSET
    })

    val = dados.get('validade') or '---'
    data = formatar_data(dados.get('data_inventario', ''))

    linhas = [
        f"ITEM: {dados.get('codigo', '')}",
        f"LOTE: {dados.get('lote', '')}",
        f"VAL: {val}",
        f"QNT: {dados.get('quantidade', 0)} UNIDADES",
        f"Nome: {dados.get('operador', '')}",
        f"INVENTARIO: {data}",
    ]

    hdc.StartDoc("Etiqueta MSB")
    hdc.StartPage()
    old_font = hdc.SelectObject(font)

    # Margem esquerda: 1.5mm, topo: 1.5mm, espacamento entre linhas: 9.5mm
    x       = mm_x(1.5)
    y_base  = mm_y(1.5)
    y_step  = mm_y(9.5)

    for i, texto in enumerate(linhas):
        hdc.TextOut(x, y_base + i * y_step, texto)

    hdc.SelectObject(old_font)
    hdc.EndPage()
    hdc.EndDoc()
    hdc.DeleteDC()


def log(msg: str):
    hora = datetime.now().strftime('%H:%M:%S')
    print(f"  [{hora}] {msg}")


# ── HTTP Handler ──────────────────────────────────────────────────────────────

class AgentHandler(BaseHTTPRequestHandler):
    printer_name: str = ''

    def log_message(self, fmt, *args):
        pass  # silencia log padrao

    def _enviar(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/status':
            self._enviar(200, {
                'ok': True,
                'printer': AgentHandler.printer_name,
                'version': '2.0',
                'agent': 'MSB Print Agent',
                'method': 'GDI'
            })
        else:
            self._enviar(404, {'ok': False, 'erro': 'Not found'})

    def do_POST(self):
        if self.path != '/print':
            self._enviar(404, {'ok': False, 'erro': 'Not found'})
            return

        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))

            imprimir_gdi(body, AgentHandler.printer_name)
            log(f"Impresso -> {AgentHandler.printer_name}")
            self._enviar(200, {'ok': True, 'printer': AgentHandler.printer_name})

        except Exception as e:
            log(f"ERRO ao imprimir: {e}")
            self._enviar(500, {'ok': False, 'erro': str(e)})


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    os.system('cls' if os.name == 'nt' else 'clear')
    print("\n" + "="*55)
    print("  MSB Print Agent v2.0")
    print("="*55)

    print("\n  Buscando impressora TLP 2844...")
    printer = encontrar_tlp2844()

    if not printer:
        print("\n  ERRO: Impressora TLP 2844 nao encontrada!")
        print("  Verifique se o driver ZDesigner TLP 2844 esta instalado.")
        input("\n  Pressione ENTER para sair...")
        sys.exit(1)

    AgentHandler.printer_name = printer

    print(f"\n  Impressora : {printer}")
    print(f"  Metodo     : GDI (driver ZDesigner)")
    print(f"  Endereco   : http://localhost:{PORT}")
    print(f"\n  Aguardando trabalhos de impressao...")
    print("  (feche esta janela ou pressione Ctrl+C para parar)\n")
    print("-"*55)

    server = HTTPServer(('localhost', PORT), AgentHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n  Agente encerrado.")
        server.server_close()


if __name__ == '__main__':
    main()
