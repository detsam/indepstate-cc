# tv-proxy Service

The `tv-proxy` service runs a local [mitmdump](https://docs.mitmproxy.org/stable/concepts-mitm-dump/) proxy using the `extensions/mitmproxy/tv-wslog.py` addon. The addon is looked up first inside the packaged application (`app.asar`), then in the `extensions/mitmproxy` directory inside the user data folder (e.g. `%LOCALAPPDATA%/ISCC` on Windows) and finally next to the executable. It captures TradingView WebSocket traffic and forwards messages containing `@ATR` to an internal webhook.

## Configuration

Configure via `app/config/tv-proxy.json`:

- `enabled` (boolean, default `false`) – enable or disable the service.
- `proxyPort` (number, default `8888`) – port on which mitmdump listens.
- `webhookPort` (number) – port of the local `/webhook` endpoint to forward messages to.
- `webhookUrl` (string) – optional full URL for the webhook; takes precedence over `webhookPort`.

Either `webhookPort` or `webhookUrl` must be provided when the service is enabled.

## Requirements

`mitmdump` must be installed and available in `PATH`.

## Logging

Startup and proxy events are appended to `logs/tv-proxy.txt` inside the user data folder (e.g. `%LOCALAPPDATA%/ISCC/logs/tv-proxy.txt` on Windows).
