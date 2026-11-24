"""Docker healthcheck: the console may run on HTTP or (with a certificate) HTTPS."""
import os
import ssl
import sys
import urllib.request

port = os.environ.get("PORT", "21114")
ctx = ssl._create_unverified_context()
for scheme in ("http", "https"):
    try:
        urllib.request.urlopen("%s://127.0.0.1:%s/api/health" % (scheme, port), timeout=4, context=ctx)
        sys.exit(0)
    except Exception:
        pass
sys.exit(1)
