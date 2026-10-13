#!/usr/bin/env python3
"""Serves the repo for the prototype and prints the addresses to open it,
including this computer's IP in the local network (for phones and tablets).

    python3 scripts/serve.py [port]      # default port 8000
"""
import http.server
import socket
import sys
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def lan_ips():
    """IPv4 addresses of this computer in the local network."""
    ips = set()
    try:
        # Connecting a UDP socket sends nothing; it only picks the outgoing interface.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 80))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        ips.update(info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("0.0.0.0", port), handler) as server:
        print("NoteDown prototype:")
        print(f"  this computer:  http://localhost:{port}/app/")
        for ip in lan_ips():
            print(f"  other devices:  http://{ip}:{port}/app/")
        print("Ctrl+C stops the server.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
