# Test Fixtures

Self-signed certificate for the TLS half of `connection-liveness.test.ts`, which
needs a real `tls.createServer`. Tests connect with `rejectUnauthorized: false`,
so the certificate only has to exist and parse.

TLS is covered separately from plain TCP because node-imap registers its
socket-timeout handler on the TLS socket while arming the timer on the raw
socket, so its own watchdog never fires over TLS.

Regenerate with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 10000 \
  -keyout key.pem -out certificate.pem \
  -subj "/C=US/ST=Test/L=Test/O=Test/CN=localhost"
```
