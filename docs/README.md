# Project Documentation

This directory contains high-level notes about the codebase.

## Overview
- `app/main.js` – Electron main process wiring adapters and relaying events to the renderer
- `app/renderer.js` – UI layer showing order cards and status indicators
- `app/services/events.js` – lightweight event bus for `order:placed`, `position:opened` and `position:closed`
- `app/adapters/*` – execution adapters such as the DWX connector, each can provide `listOpenOrders()` and `listClosedPositions()`

More documents can be added here as the project evolves.
