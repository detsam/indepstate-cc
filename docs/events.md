# Event Bus

A minimal event emitter used across the application. It broadcasts the following order lifecycle events:

- `order:placed`
- `position:opened`
- `position:closed`
- `order:cancelled`

Other services subscribe to these events to react to changes.
