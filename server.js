const WebSocket = require('ws');

const PORT = 8080;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Client state: { ws, world, x, y, plane, username, lastSeen, isAlive }
const clients = new Map();

// Chebyshev distance (matches OSRS tile distance)
function chebyshevDistance(x1, y1, x2, y2) {
	return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

function distance3D(x1, y1, z1, x2, y2, z2) {
	if (z1 !== z2) return Infinity;
	return chebyshevDistance(x1, y1, x2, y2);
}

const wss = new WebSocket.Server({ port: PORT });

console.log(`TileWhisper relay server listening on port ${PORT}`);

function sendWelcome(ws) {
	ws.send(JSON.stringify({ type: 'welcome' }));
}

// Send the nearby players list to a single client
function sendNearbyPlayers(clientId) {
	const client = clients.get(clientId);
	if (!client) return;

	const nearby = [];
	const maxDistance = 50;

	for (const [id, other] of clients.entries()) {
		if (id === clientId) continue;
		if (other.world === client.world) {
			const dist = distance3D(client.x, client.y, client.plane, other.x, other.y, other.plane);
			if (dist <= maxDistance) {
				nearby.push({ username: other.username, world: other.world, x: other.x, y: other.y, plane: other.plane });
			}
		}
	}

	client.ws.send(JSON.stringify({ type: 'nearby', players: nearby }));
}

// Forward an audio packet to all nearby clients (excluding sender)
function forwardAudioToNearby(senderId, audioData, x, y, plane) {
	const sender = clients.get(senderId);
	if (!sender) return;

	const maxDistance = 50;

	for (const [id, client] of clients.entries()) {
		if (id === senderId) continue;
		if (client.world === sender.world) {
			const dist = distance3D(x, y, plane, client.x, client.y, client.plane);
			if (dist <= maxDistance) {
				client.ws.send(audioData, { binary: true });
			}
		}
	}
}

// Parse binary audio packet header (same format as VoicePacket.java)
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

wss.on('connection', (ws, req) => {
	const clientId = req.headers['sec-websocket-key'] || Date.now() + Math.random();
	console.log(`Client connected: ${clientId}`);

	clients.set(clientId, { ws, world: 0, x: 0, y: 0, plane: 0, username: '', lastSeen: Date.now(), isAlive: true });

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
			try {
				const packet = parseAudioPacket(data);
				if (packet) {
					console.log(`Audio from ${packet.username} (${data.byteLength} bytes)`);
					forwardAudioToNearby(clientId, data, packet.x, packet.y, packet.plane);
				} else {
					console.warn(`Malformed audio packet from ${clientId} (${data.byteLength} bytes)`);
				}
			} catch (err) {
				console.error(`Error parsing audio packet from ${clientId}:`, err);
			}
		} else {
			try {
				const message = JSON.parse(data);
				if (message.type === 'presence') {
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
		console.log(`Client disconnected: ${clientId} (${code})`);
		const client = clients.get(clientId);
		clients.delete(clientId);
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

// Heartbeat: ping all clients, terminate ones that don't respond
setInterval(() => {
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
}, HEARTBEAT_INTERVAL);

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('Shutting down...');
	wss.clients.forEach(ws => ws.close());
	wss.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});
