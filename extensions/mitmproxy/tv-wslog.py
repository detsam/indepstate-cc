# tv-wslog.py — лог WS-кадров (текст); бинарь — в base64
import json, base64, re
from mitmproxy import http

# ==== настройки фильтрации (по желанию) ====
HOST_ALLOW = None               # например: r"tradingview\.com$"  (None = все хосты)
#RX = r'"event"\s*:\s*"alert"'   # например: r"ASTS"  (None = печатать всё)
RX = r'alert_fired'
rx_host = re.compile(HOST_ALLOW, re.I) if HOST_ALLOW else None
rx_text = re.compile(RX, re.I) if RX else None

def _host_ok(flow: http.HTTPFlow) -> bool:
    h = flow.request.pretty_host
    return True if not rx_host else bool(rx_host.search(h))

def _text_ok(text: str) -> bool:
    return True if not rx_text else bool(rx_text.search(text))

def websocket_start(flow: http.HTTPFlow):
    # просто метка начала — полезно убедиться, что перехват пошёл
    if not _host_ok(flow):
        return
    print(json.dumps({
        "event": "start",
        "host": flow.request.pretty_host,
        "path": flow.request.path
    }, ensure_ascii=False), flush=True)

def websocket_message(flow: http.HTTPFlow):
    # ВАЖНО: сообщения лежат в flow.websocket.messages
    if flow.websocket is None:
        return
    if not _host_ok(flow):
        return
    try:
        msg = flow.websocket.messages[-1]   # mitmproxy.ws.WebSocketMessage
    except Exception:
        return

    data = msg.content  # bytes
    direction = "out" if msg.from_client else "in"

    # пробуем как UTF-8 текст
    text = None
    try:
        text = data.decode("utf-8")
    except Exception:
        text = None

    # фильтрация по тексту, если задана
    if text is not None:
        if not _text_ok(text):
            return
        out = {
            "event": "message",
            "dir": direction,
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "text": text[:2000]  # чтобы не раздувать лог
        }
    else:
        # бинарные кадры — складываем как base64
        b64 = base64.b64encode(data).decode("ascii")
        # если нужно фильтровать бинарь — можно добавить тут
        out = {
            "event": "message",
            "dir": direction,
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "bin": b64
        }

    print(json.dumps(out, ensure_ascii=False), flush=True)

def websocket_end(flow: http.HTTPFlow):
    if not _host_ok(flow):
        return
    print(json.dumps({
        "event": "end",
        "host": flow.request.pretty_host,
        "path": flow.request.path
    }, ensure_ascii=False), flush=True)
