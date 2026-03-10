const WebSocket = require('ws');

// ========================================================================
// Pure helper functions (exported for unit testing)
// ========================================================================

function chebyshevDistance(x1, y1, x2, y2) {
	return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

function distance3D(x1, y1, z1, x2, y2, z2) {
	if (z1 !== z2) return Infinity;
	return chebyshevDistance(x1, y1, x2, y2);
}

// Parse binary audio packet header (same format as VoicePacket.java)
// Layout: [world:4 LE][x:4 LE][y:4 LE][plane:1][usernameLen:1][username:N][audio:M]
function parseAudioPacket(buffer) {
	if (buffer.length < 14) return null;

	const world = buffer.readUInt32LE(0);
	const x = buffer.readUInt32LE(4);
	const y = buffer.readUInt32LE(8);
	const plane = buffer.readUInt8(12);
	const usernameLen = buffer.readUInt8(13);

	if (buffer.length < 14 + usernameLen) return null;

	const username = buffer.toString('utf8', 14, 14 + usernameLen);
	return { world, x, y, plane, username };
}

// ========================================================================
// Server factory (used directly and in tests with isolated config)
// ========================================================================

function createServer({
	port = 8080,
	maxConnectionsPerIp = 3,
	maxTotalConnections = 500,
	maxAudioFramesPerSec = 60,
	maxBinaryPayloadBytes = 1400,
	maxPresencePerSec = 1,
	maxJsonPayloadBytes = 512,
	nearbyMaxDistance = 50,
} = {}) {
	// Client state: { ws, ip, world, x, y, plane, username, lastSeen, isAlive,
	//                  audioFrameCount, audioWindowStart,
	//                  presenceCount, presenceWindowStart }
	const clients = new Map();

	const wss = new WebSocket.Server({ port });

	function sendWelcome(ws) {
		ws.send(JSON.stringify({ type: 'welcome' }));
	}

	function sendNearbyPlayers(clientId) {
		const client = clients.get(clientId);
		if (!client) return;

		const nearby = [];

		for (const [id, other] of clients.entries()) {
			if (id === clientId) continue;
			if (other.world === client.world) {
				const dist = distance3D(client.x, client.y, client.plane, other.x, other.y, other.plane);
				if (dist <= nearbyMaxDistance) {
					nearby.push({ username: other.username, world: other.world, x: other.x, y: other.y, plane: other.plane });
				}
			}
		}

		client.ws.send(JSON.stringify({ type: 'nearby', players: nearby }));
	}

	function forwardAudioToNearby(senderId, audioData, x, y, plane) {
		const sender = clients.get(senderId);
		if (!sender) return;

		for (const [id, client] of clients.entries()) {
			if (id === senderId) continue;
			if (client.world === sender.world) {
				const dist = distance3D(x, y, plane, client.x, client.y, client.plane);
				if (dist <= nearbyMaxDistance) {
					client.ws.send(audioData, { binary: true });
				}
			}
		}
	}

	wss.on('connection', (ws, req) => {
		const clientIp = req.socket.remoteAddress;

		// Enforce global connection cap
		if (clients.size >= maxTotalConnections) {
			console.warn(`Connection rejected from ${clientIp}: server full (${clients.size}/${maxTotalConnections})`);
			ws.close(1008, 'Server full, try again later');
			return;
		}

		// Enforce per-IP connection limit
		const existingConnections = Array.from(clients.values())
			.filter(c => c.ip === clientIp).length;

		if (existingConnections >= maxConnectionsPerIp) {
			console.warn(`Connection rejected from ${clientIp}: too many connections (${existingConnections}/${maxConnectionsPerIp})`);
			ws.close(1008, 'Too many connections from your IP');
			return;
		}

		const clientId = req.headers['sec-websocket-key'] || `${Date.now()}-${Math.random()}`;
		console.log(`Client connected: ${clientId} (${clientIp})`);

		clients.set(clientId, {
			ws,
			ip: clientIp,
			world: 0, x: 0, y: 0, plane: 0,
			username: '',
			lastSeen: Date.now(),
			isAlive: true,
			audioFrameCount: 0,
			audioWindowStart: Date.now(),
			presenceCount: 0,
			presenceWindowStart: Date.now(),
		});

		sendWelcome(ws);

		ws.on('pong', () => {
			const client = clients.get(clientId);
			if (client) client.isAlive = true;
		});

		ws.on('message', (data, isBinary) => {
			const client = clients.get(clientId);
			if (!client) return;

			client.lastSeen = Date.now();

			if (isBinary) {
				// Reject oversized packets
				if (data.byteLength > maxBinaryPayloadBytes) {
					console.warn(`Oversized packet from ${clientId} (${data.byteLength} bytes), dropping`);
					return;
				}

				// Rate limit audio frames per second
				const now = Date.now();
				if (now - client.audioWindowStart >= 1000) {
					client.audioWindowStart = now;
					client.audioFrameCount = 0;
				}
				client.audioFrameCount++;
				if (client.audioFrameCount > maxAudioFramesPerSec) {
					return; // Drop silently
				}

				try {
					const packet = parseAudioPacket(data);
					if (packet) {
						forwardAudioToNearby(clientId, data, packet.x, packet.y, packet.plane);
					} else {
						console.warn(`Malformed audio packet from ${clientId} (${data.byteLength} bytes)`);
					}
				} catch (err) {
					console.error(`Error parsing audio packet from ${clientId}:`, err);
				}
			} else {
				// Reject oversized JSON payloads
				if (data.length > maxJsonPayloadBytes) {
					console.warn(`Oversized JSON from ${clientId} (${data.length} bytes), dropping`);
					return;
				}

				try {
					const message = JSON.parse(data);
					if (message.type === 'presence') {
						// Rate limit presence messages
						const now = Date.now();
						if (now - client.presenceWindowStart >= 1000) {
							client.presenceWindowStart = now;
							client.presenceCount = 0;
						}
						client.presenceCount++;
						if (client.presenceCount > maxPresencePerSec) {
							return; // Drop silently
						}

						client.world = message.world;
						client.x = message.x;
						client.y = message.y;
						client.plane = message.plane;
						client.username = message.username;

						for (const [id, otherClient] of clients.entries()) {
							if (otherClient.world === client.world) {
								sendNearbyPlayers(id);
							}
						}
					}
				} catch (err) {
					console.error(`Error parsing JSON message from ${clientId}:`, err);
				}
			}
		});

		ws.on('close', (code) => {
			const client = clients.get(clientId);
			const clientWorld = client?.world || 0;
			console.log(`Client disconnected: ${clientId} ip=${client?.ip} (${code})`);
			clients.delete(clientId);
			for (const [id, otherClient] of clients.entries()) {
				if (otherClient.world === clientWorld) {
					sendNearbyPlayers(id);
				}
			}
		});

		ws.on('error', (err) => {
			console.error(`WebSocket error for ${clientId}:`, err);
		});
	});

	// Heartbeat: ping all clients, terminate ones that don't respond
	const heartbeat = setInterval(() => {
		for (const [id, client] of clients.entries()) {
			if (!client.isAlive) {
				console.log(`Client ${id} terminated (no pong)`);
				client.ws.terminate();
				clients.delete(id);
				continue;
			}
			client.isAlive = false;
			if (client.ws.readyState === WebSocket.OPEN) {
				client.ws.ping();
			}
		}
	}, 30000);

	wss.on('close', () => clearInterval(heartbeat));

	return wss;
}

// ========================================================================
// Entrypoint
// ========================================================================

if (require.main === module) {
	const PORT = parseInt(process.env.PORT || '8080', 10);
	createServer({ port: PORT });
	console.log(`TileWhisper relay server listening on port ${PORT}`);

	process.on('SIGINT', () => {
		console.log('Shutting down...');
		process.exit(0);
	});
}

module.exports = { createServer, parseAudioPacket, chebyshevDistance, distance3D };
