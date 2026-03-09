const WebSocket = require('ws');

const PORT = 8080;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Client state: { ws, world, x, y, plane, username, lastSeen }
const clients = new Map();

// Helper: Chebyshev distance between two points
function chebyshevDistance(x1, y1, x2, y2) {
	return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

// Helper: Calculate distance between two 3D points (including plane)
function distance3D(x1, y1, z1, x2, y2, z2) {
	if (z1 !== z2) {
		return Infinity; // Different planes are infinitely far
	}
	return chebyshevDistance(x1, y1, x2, y2);
}

// Create WebSocket server
const wss = new WebSocket.Server({ port: PORT });

console.log(`TileWhisper relay server listening on port ${PORT}`);

// Send welcome message to new client
function sendWelcome(ws) {
	ws.send(JSON.stringify({ type: 'welcome' }));
}

// Send nearby players list to a client
function sendNearbyPlayers(clientId) {
	const client = clients.get(clientId);
	if (!client) return;

	const nearby = [];
	const maxDistance = 50; // Server filters wider than client to prevent edge cutoff

	for (const [id, other] of clients.entries()) {
		if (id === clientId) continue; // Skip self

		// Check if same world and within range
		if (other.world === client.world) {
			const dist = distance3D(client.x, client.y, client.plane, other.x, other.y, other.plane);
			if (dist <= maxDistance) {
				nearby.push({
					username: other.username,
					world: other.world,
					x: other.x,
					y: other.y,
					plane: other.plane
				});
			}
		}
	}

	client.ws.send(JSON.stringify({
		type: 'nearby',
		players: nearby
	}));
}

// Forward audio packet to nearby clients
function forwardAudioToNearby(senderId, audioData, x, y, plane) {
	const sender = clients.get(senderId);
	if (!sender) return;

	const maxDistance = 50;

	for (const [id, client] of clients.entries()) {
		if (id === senderId) continue;

		if (client.world === sender.world) {
			const dist = distance3D(x, y, plane, client.x, client.y, client.plane);
			if (dist <= maxDistance) {
				// Forward raw audio bytes
				client.ws.send(audioData, { binary: true });
			}
		}
	}
}

// Parse binary audio packet (same format as VoicePacket.java)
function parseAudioPacket(buffer) {
	if (buffer.length < 14) return null;

	const view = new DataView(buffer);
	let offset = 0;

	const world = view.getUint32(offset, true); // little-endian
	offset += 4;

	const x = view.getUint32(offset, true);
	offset += 4;

	const y = view.getUint32(offset, true);
	offset += 4;

	const plane = view.getUint8(offset);
	offset += 1;

	const usernameLen = view.getUint8(offset);
	offset += 1;

	if (buffer.length < 14 + usernameLen) return null;

	const usernameBytes = new Uint8Array(buffer, offset, usernameLen);
	const username = new TextDecoder().decode(usernameBytes);
	offset += usernameLen;

	const audioData = buffer.slice(offset);

	return { world, x, y, plane, username, audioData };
}

wss.on('connection', (ws, req) => {
	const clientId = req.headers['sec-websocket-key'] || Date.now() + Math.random();
	console.log(`Client connected: ${clientId}`);

	// Initialize client state
	clients.set(clientId, {
		ws,
		world: 0,
		x: 0,
		y: 0,
		plane: 0,
		username: '',
		lastSeen: Date.now(),
		isAlive: true
	});

	sendWelcome(ws);

	// Handle pong response
	ws.on('pong', () => {
		const client = clients.get(clientId);
		if (client) {
			client.isAlive = true;
		}
	});

	// Handle incoming messages
	ws.on('message', (data, isBinary) => {
		const client = clients.get(clientId);
		if (!client) return;

		client.lastSeen = Date.now();

		if (isBinary) {
			// Binary audio packet
			try {
				const packet = parseAudioPacket(data);
				if (packet) {
					forwardAudioToNearby(clientId, data, packet.x, packet.y, packet.plane);
				}
			} catch (err) {
				console.error(`Error parsing audio packet from ${clientId}:`, err);
			}
		} else {
			// JSON text message
			try {
				const message = JSON.parse(data);
				if (message.type === 'presence') {
					// Update client state
					client.world = message.world;
					client.x = message.x;
					client.y = message.y;
					client.plane = message.plane;
					client.username = message.username;

					// Broadcast updated nearby players to all clients in same world
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

	ws.on('close', (code, reason) => {
		console.log(`Client disconnected: ${clientId} (${code})`);

		// Remove client
		clients.delete(clientId);

		// Update nearby players for remaining clients
		const clientWorld = client?.world || 0;
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

// Heartbeat: check for dead clients and ping alive ones
setInterval(() => {
	const now = Date.now();

	for (const [id, client] of clients.entries()) {
		// Terminate clients that haven't responded to ping
		if (!client.isAlive) {
			console.log(`Client ${id} terminated (no pong)`);
			client.ws.terminate();
			clients.delete(id);
			continue;
		}

		// Mark as dead until pong received
		client.isAlive = false;

		// Send ping
		if (client.ws.readyState === WebSocket.OPEN) {
			client.ws.ping();
		}
	}
}, HEARTBEAT_INTERVAL);

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('Shutting down...');
	wss.clients.forEach(ws => {
		ws.close();
	});
	wss.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});
