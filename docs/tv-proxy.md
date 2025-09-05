# tv-proxy Service

The `tv-proxy` service runs a local [mitmdump](https://docs.mitmproxy.org/stable/concepts-mitm-dump/) proxy using the `extensions/mitmproxy/tv-wslog.py` addon. It captures TradingView WebSocket traffic and forwards messages containing `@ATR` to an internal webhook.

## Configuration

Configure via `app/config/tv-proxy.json`:

- `enabled` (boolean, default `false`) – enable or disable the service.
- `proxyPort` (number, default `8888`) – port on which mitmdump listens.
- `webhookPort` (number) – port of the local `/webhook` endpoint to forward messages to.
- `webhookUrl` (string) – optional full URL for the webhook; takes precedence over `webhookPort`.

Either `webhookPort` or `webhookUrl` must be provided when the service is enabled.

## Requirements

`mitmdump` must be installed and available in `PATH`.
