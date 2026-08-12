#!/usr/bin/env python3
"""Minimal static file server for TLF Quick Checker (avoids os.getcwd sandbox issues)."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DIRECTORY = "/Users/rmin/Desktop/TLFQuickChecker"
PORT = 8777

Handler = functools.partial(SimpleHTTPRequestHandler, directory=DIRECTORY)
httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
print(f"Serving {DIRECTORY} at http://127.0.0.1:{PORT}")
httpd.serve_forever()
