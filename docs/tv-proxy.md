# tv-proxy Service

The `tv-proxy` service runs a local [mitmdump](https://docs.mitmproxy.org/stable/concepts-mitm-dump/) proxy using the `extensions/mitmproxy/tv-wslog.py` addon. The addon is looked up first inside the packaged application (`app.asar`), then in the `extensions/mitmproxy` directory inside the user data folder (e.g. `%LOCALAPPDATA%/ISCC` on Windows) and finally next to the executable. When the addon is found inside `app.asar`, it is extracted to the user data folder before launching `mitmdump` so Python can load it. The service captures TradingView WebSocket traffic and exposes parsed messages to registered listeners.

## Configuration

Configure via `app/services/tvProxy/config/tv-proxy.json`:

- `enabled` (boolean, default `false`) – enable or disable the service.
- `log` (boolean, default `false`) – write startup and proxy events to a log file.
- `proxyPort` (number, default `8888`) – port where the proxy listens.

Other services may register listeners on the proxy to react to parsed messages, such as forwarding specific events to webhooks.

## Requirements

`mitmdump` must be installed and available in `PATH`.

## Logging
When `log` is set to `true`, startup and proxy events are appended to `logs/tv-proxy.txt` inside the user data folder (e.g. `%LOCALAPPDATA%/ISCC/logs/tv-proxy.txt` on Windows).
