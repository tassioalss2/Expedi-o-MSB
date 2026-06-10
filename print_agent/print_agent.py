"""
MSB Print Agent v1.0
====================
Agente local de impressao para Zebra TLP 2844.

Roda em segundo plano no computador com a impressora conectada.
O ACE-MSB envia o ZPL via HTTP e este agente imprime automaticamente.

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
        for p in impressoras:
            nome = p['pPrinterName'].lower()
            if '2844' in nome or ('tlp' in nome and 'zebra' in nome):
                return p['pPrinterName']
        # Segunda passagem: qualquer Zebra que nao seja ZD230
        for p in impressoras:
            nome = p['pPrinterName'].lower()
            if 'zd230' in nome:
                continue
            if 'zebra' in nome or 'zdesigner' in nome:
                return p['pPrinterName']
    except Exception as e:
        print(f"  Erro ao listar impressoras: {e}")
    return None


def imprimir_zpl(zpl: str, nome_impressora: str) -> None:
    """Envia ZPL diretamente para o spooler Windows em modo RAW."""
    handle = win32print.OpenPrinter(nome_impressora)
    try:
        win32print.StartDocPrinter(handle, 1, ("Etiqueta MSB", None, "RAW"))
        try:
            win32print.StartPagePrinter(handle)
            win32print.WritePrinter(handle, zpl.encode('ascii', errors='replace'))
            win32print.EndPagePrinter(handle)
        finally:
            win32print.EndDocPrinter(handle)
    finally:
        win32print.ClosePrinter(handle)


def log(msg: str):
    hora = datetime.now().strftime('%H:%M:%S')
    print(f"  [{hora}] {msg}")


# ── HTTP Handler ──────────────────────────────────────────────────────────────

class AgentHandler(BaseHTTPRequestHandler):
    printer_name: str = ''

    def log_message(self, fmt, *args):
        pass  # silencia log padrao do HTTPServer

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
                'version': '1.0',
                'agent': 'MSB Print Agent'
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
            zpl = body.get('zpl', '').strip()

            if not zpl:
                self._enviar(400, {'ok': False, 'erro': 'ZPL vazio'})
                return

            imprimir_zpl(zpl, AgentHandler.printer_name)
            log(f"Impresso -> {AgentHandler.printer_name}")
            self._enviar(200, {'ok': True, 'printer': AgentHandler.printer_name})

        except Exception as e:
            log(f"ERRO ao imprimir: {e}")
            self._enviar(500, {'ok': False, 'erro': str(e)})


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    os.system('cls' if os.name == 'nt' else 'clear')
    print("\n" + "="*55)
    print("  MSB Print Agent v1.0")
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
