# TileWhisper Server

Relay server for the [TileWhisper](https://github.com/ahornerr/TileWhisper) RuneLite plugin. Clients connect via WebSocket and the server forwards Opus-encoded voice packets to nearby players on the same OSRS world.

## How it works

1. Clients send a `presence` JSON message on connect and whenever their position changes.
2. The server tracks each client's world, tile coordinates, and plane.
3. Incoming binary audio packets are forwarded to all clients within `nearbyMaxDistance` tiles (Chebyshev distance) on the same world and plane.
4. The server never decodes audio — it forwards raw binary frames as-is.

## Wire protocol

### Text frames (client → server)

```json
{ "type": "presence", "world": 301, "x": 3200, "y": 3200, "plane": 0, "username": "Zezima" }
```

### Text frames (server → client)

```json
{ "type": "welcome" }
{ "type": "nearby", "players": [{ "username": "Zezima", "world": 301, "x": 3200, "y": 3200, "plane": 0 }] }
```

### Binary frames

`[world:4 LE][x:4 LE][y:4 LE][plane:1][usernameLen:1][username:N][opusAudio:M]`

## Running

### Node.js

```
npm install
node server.js
```

The server listens on port `8080` by default. Set `PORT` to override:

```
PORT=9000 node server.js
```

### Docker

```
docker build -t tilewhisper-server .
docker run -p 8080:8080 tilewhisper-server
```

### Docker Compose

```
docker compose up -d
```

The compose file maps host port `2376` → container port `8080`.

### GitHub Container Registry

Pre-built images are published to GHCR on every push to `master`:

```
docker pull ghcr.io/ahornerr/tilewhisperserver:latest
docker run -p 8080:8080 ghcr.io/ahornerr/tilewhisperserver:latest
```

## Configuration

All limits are set via `createServer()` options (not yet exposed as env vars — the defaults are suitable for public deployment):

| Option | Default | Description |
|---|---|---|
| `port` | `8080` | WebSocket listen port |
| `maxConnectionsPerIp` | `3` | Max simultaneous connections per IP |
| `maxTotalConnections` | `500` | Global connection cap |
| `maxAudioFramesPerSec` | `60` | Max binary frames per client per second |
| `maxBinaryPayloadBytes` | `1400` | Max size of a binary frame |
| `maxPresencePerSec` | `1` | Max presence updates per client per second |
| `maxJsonPayloadBytes` | `512` | Max size of a JSON text frame |
| `nearbyMaxDistance` | `50` | Tile radius for audio forwarding |

## Development

```
npm test
```

Tests use Jest and spin up isolated in-process server instances on ephemeral ports.
