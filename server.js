const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { StatsCollector } = require('./stats');

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

// Validate OSRS username format (1-12 chars, must start with letter, then letters/numbers/spaces/hyphens)
function isValidUsername(username) {
	if (typeof username !== 'string') return false;
	if (username.length < 1 || username.length > 12) return false;
	return /^[A-Za-z][A-Za-z0-9 _-]{0,11}$/.test(username) && !/  /.test(username);
}

// Validate OSRS coordinate range (0-16383)
function isValidCoordinate(coord) {
	return Number.isInteger(coord) && coord >= 0 && coord <= 16383;
}

// Validate OSRS plane (0-3)
function isValidPlane(plane) {
	return Number.isInteger(plane) && plane >= 0 && plane <= 3;
}

// Validate OSRS world ID (positive integer, reasonable range)
function isValidWorld(world) {
	return Number.isInteger(world) && world >= 1 && world <= 10000;
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
	statsPort = null,
	statsHistoryMinutes = 1440,
	maxConnectionsPerIp = 3,
	maxTotalConnections = 500,
	maxConnectionsPerUsername = 2,
	maxAudioFramesPerSec = 60,
	maxBinaryPayloadBytes = 1400,
	maxPresencePerSec = 1,
	maxJsonPayloadBytes = 512,
	nearbyMaxDistance = 50,
	// Burst detection: 30-second window limits
	maxAudioFramesPer30Sec = 1200,  // ~40/sec sustained average
	maxPresencePer30Sec = 30,
} = {}) {
	const collector = new StatsCollector({ historyMinutes: statsHistoryMinutes });
	// Client state: { ws, ip, world, x, y, plane, username, lastSeen, isAlive,
	//                  audioFrameCount, audioWindowStart,
	//                  audioFrameCount30s, audioWindow30Start,
	//                  presenceCount, presenceWindowStart,
	//                  presenceCount30s, presenceWindow30Start }
	const clients = new Map();

	// Per-world client sets for O(1) world lookups
	const worldClients = new Map();

	// Per-username connection tracking
	const usernameToClientIds = new Map();

	// Use noServer when statsPort === port so both share one HTTP server
	const wss = (statsPort && statsPort === port)
		? new WebSocket.Server({ noServer: true })
		: new WebSocket.Server({ port });

	// Atomic counter for client IDs (more reliable than Sec-WebSocket-Key)
	let clientIdCounter = 0;

	function sendWelcome(ws) {
		ws.send(JSON.stringify({ type: 'welcome' }));
	}

	function sendNearbyPlayers(clientId) {
		const client = clients.get(clientId);
		if (!client) return;

		const nearby = [];
		const worldSet = worldClients.get(client.world);
		if (!worldSet) return;

		for (const id of worldSet) {
			if (id === clientId) continue;
			const other = clients.get(id);
			if (!other) continue;

			const dist = distance3D(client.x, client.y, client.plane, other.x, other.y, other.plane);
			if (dist <= nearbyMaxDistance) {
				nearby.push({ username: other.username, world: other.world, x: other.x, y: other.y, plane: other.plane });
			}
		}

		client.ws.send(JSON.stringify({ type: 'nearby', players: nearby }));
	}

	function forwardAudioToNearby(senderId, audioData, x, y, plane) {
		const sender = clients.get(senderId);
		if (!sender) return;

		const worldSet = worldClients.get(sender.world);
		if (!worldSet) return;

		for (const id of worldSet) {
			if (id === senderId) continue;
			const client = clients.get(id);
			if (!client) continue;

			const dist = distance3D(x, y, plane, client.x, client.y, client.plane);
			if (dist <= nearbyMaxDistance) {
				client.ws.send(audioData, { binary: true });
			}
		}
	}

	wss.on('connection', (ws, req) => {
		const clientIp = req.socket.remoteAddress;

		// Enforce global connection cap
		if (clients.size >= maxTotalConnections) {
			console.warn(`Connection rejected from ${clientIp}: server full (${clients.size}/${maxTotalConnections})`);
			collector.onConnectionRejected('server_full');
			ws.close(1008, 'Server full, try again later');
			return;
		}

		// Enforce per-IP connection limit
		const ipConnections = Array.from(clients.values())
			.filter(c => c.ip === clientIp).length;

		if (ipConnections >= maxConnectionsPerIp) {
			console.warn(`Connection rejected from ${clientIp}: too many connections (${ipConnections}/${maxConnectionsPerIp})`);
			collector.onConnectionRejected('ip_limit');
			ws.close(1008, 'Too many connections from your IP');
			return;
		}

		const clientId = String(++clientIdCounter);
		console.log(`Client connected: ${clientId} (${clientIp})`);

		const now = Date.now();
		clients.set(clientId, {
			ws,
			ip: clientIp,
			world: 0, x: 0, y: 0, plane: 0,
			username: '',
			openTime: now,
			lastSeen: now,
			isAlive: true,
			pingTime: null,
			audioFrameCount: 0,
			audioWindowStart: now,
			audioFrameCount30s: 0,
			audioWindow30Start: now,
			presenceCount: 0,
			presenceWindowStart: now,
			presenceCount30s: 0,
			presenceWindow30Start: now,
		});

		collector.onConnectionAccepted();
		sendWelcome(ws);

		ws.on('pong', () => {
			const client = clients.get(clientId);
			if (client) {
				client.isAlive = true;
				if (client.pingTime !== null) {
					collector.onPingLatency(Date.now() - client.pingTime);
					client.pingTime = null;
				}
			}
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
					collector.onAudioFrameDropped();
					return; // Drop silently
				}

				// Burst detection: 30-second window
				if (now - client.audioWindow30Start >= 30000) {
					client.audioWindow30Start = now;
					client.audioFrameCount30s = 0;
				}
				client.audioFrameCount30s++;
				if (client.audioFrameCount30s > maxAudioFramesPer30Sec) {
					console.warn(`Burst audio detected from ${clientId}, dropping`);
					collector.onAudioFrameDropped();
					return;
				}

				try {
					const packet = parseAudioPacket(data);
					if (packet) {
						// Protocol validation for audio packets
						if (!isValidWorld(packet.world) ||
						    !isValidCoordinate(packet.x) ||
						    !isValidCoordinate(packet.y) ||
						    !isValidPlane(packet.plane) ||
						    !isValidUsername(packet.username)) {
							console.warn(`Invalid audio packet from ${clientId}: world=${packet.world}, x=${packet.x}, y=${packet.y}, plane=${packet.plane}, username=${packet.username}`);
							return;
						}
						forwardAudioToNearby(clientId, data, packet.x, packet.y, packet.plane);
						collector.onAudioFrameForwarded(data.byteLength);
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
						// Protocol validation for presence
						if (!isValidWorld(message.world) ||
						    !isValidCoordinate(message.x) ||
						    !isValidCoordinate(message.y) ||
						    !isValidPlane(message.plane) ||
						    !isValidUsername(message.username)) {
							console.warn(`Invalid presence from ${clientId}: world=${message.world}, x=${message.x}, y=${message.y}, plane=${message.plane}, username=${message.username}`);
							return;
						}

						// Enforce per-username connection limit
						const username = message.username;
						const existingUsernameIds = usernameToClientIds.get(username) || new Set();
						if (!existingUsernameIds.has(clientId)) {
							if (existingUsernameIds.size >= maxConnectionsPerUsername) {
								console.warn(`Too many connections for username ${username} (${existingUsernameIds.size}/${maxConnectionsPerUsername}), rejecting presence from ${clientId}`);
								collector.onConnectionRejected('username_limit');
								return;
							}
							existingUsernameIds.add(clientId);
							usernameToClientIds.set(username, existingUsernameIds);

							// Clean up old username entry if it exists
							if (client.username && client.username !== username) {
								const oldUsernameIds = usernameToClientIds.get(client.username);
								if (oldUsernameIds) {
									oldUsernameIds.delete(clientId);
									if (oldUsernameIds.size === 0) {
										usernameToClientIds.delete(client.username);
									}
								}
							}
						}

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

						// Burst detection: 30-second window
						if (now - client.presenceWindow30Start >= 30000) {
							client.presenceWindow30Start = now;
							client.presenceCount30s = 0;
						}
						client.presenceCount30s++;
						if (client.presenceCount30s > maxPresencePer30Sec) {
							console.warn(`Burst presence detected from ${clientId}, dropping`);
							return;
						}

						client.username = username;

						// Update world and coordinates
						const oldWorld = client.world;
						client.world = message.world;
						client.x = message.x;
						client.y = message.y;
						client.plane = message.plane;

						// Update world index
						if (oldWorld !== client.world) {
							// Remove from old world
							const oldWorldSet = worldClients.get(oldWorld);
							if (oldWorldSet) {
								oldWorldSet.delete(clientId);
								if (oldWorldSet.size === 0) {
									worldClients.delete(oldWorld);
								}
							}
							// Add to new world
							if (!worldClients.has(client.world)) {
								worldClients.set(client.world, new Set());
							}
							worldClients.get(client.world).add(clientId);
						} else {
							// Ensure client is in world set (first presence)
							if (!worldClients.has(client.world)) {
								worldClients.set(client.world, new Set());
							}
							worldClients.get(client.world).add(clientId);
						}

						collector.onPresenceProcessed();

						// Broadcast to all same-world clients
						const worldSet = worldClients.get(client.world);
						if (worldSet) {
							for (const id of worldSet) {
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
			const durationMs = client ? Date.now() - client.openTime : 0;
			collector.onConnectionClosed(durationMs);
			const clientWorld = client?.world || 0;
			const clientUsername = client?.username || '';
			console.log(`Client disconnected: ${clientId} ip=${client?.ip} (${code})`);

			// Remove from world index
			const worldSet = worldClients.get(clientWorld);
			if (worldSet) {
				worldSet.delete(clientId);
				if (worldSet.size === 0) {
					worldClients.delete(clientWorld);
				}
			}

			// Remove from username tracking
			if (clientUsername) {
				const usernameIds = usernameToClientIds.get(clientUsername);
				if (usernameIds) {
					usernameIds.delete(clientId);
					if (usernameIds.size === 0) {
						usernameToClientIds.delete(clientUsername);
					}
				}
			}

			clients.delete(clientId);

			// Notify same-world clients
			const notifySet = worldClients.get(clientWorld);
			if (notifySet) {
				for (const id of notifySet) {
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
		const terminatedWorlds = new Set();

		for (const [id, client] of clients.entries()) {
			if (!client.isAlive) {
				console.log(`Client ${id} terminated (no pong)`);

				// Record session duration
				collector.onConnectionClosed(Date.now() - client.openTime);

				// Remove from world index
				const worldSet = worldClients.get(client.world);
				if (worldSet) {
					worldSet.delete(id);
					if (worldSet.size === 0) {
						worldClients.delete(client.world);
					}
				}

				// Remove from username tracking
				if (client.username) {
					const usernameIds = usernameToClientIds.get(client.username);
					if (usernameIds) {
						usernameIds.delete(id);
						if (usernameIds.size === 0) {
							usernameToClientIds.delete(client.username);
						}
					}
				}

				terminatedWorlds.add(client.world);
				client.ws.terminate();
				clients.delete(id);
				continue;
			}
			client.isAlive = false;
			if (client.ws.readyState === WebSocket.OPEN) {
				client.pingTime = Date.now();
				client.ws.ping();
			}
		}

		// Notify remaining clients in worlds that lost a peer
		for (const world of terminatedWorlds) {
			const worldSet = worldClients.get(world);
			if (worldSet) {
				for (const id of worldSet) {
					sendNearbyPlayers(id);
				}
			}
		}
	}, 30000);

	// Snapshot interval: push stats point every 60s
	const snapshotInterval = setInterval(() => {
		collector.snapshot(clients, worldClients, usernameToClientIds);
	}, 60000);

	// Optional stats HTTP + WebSocket server
	let statsHttpServer = null;
	let statsWss = null;
	let statsTickInterval = null;

	if (statsPort) {
		const statsDir = __dirname;
		const htmlPath = path.join(statsDir, 'stats.html');
		const fontPath = path.join(statsDir, 'runescape_bold.woff2');

		let statsHtml = null;
		try { statsHtml = fs.readFileSync(htmlPath); } catch (_) {}

		const statsHttpHandler = (req, res) => {
			if (req.method !== 'GET') {
				res.writeHead(405).end();
				return;
			}

			const parsedUrl = url.parse(req.url);
			const pathname = parsedUrl.pathname;

			if (pathname === '/' || pathname === '/index.html') {
				if (!statsHtml) { res.writeHead(404).end('Not found'); return; }
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(statsHtml);
			} else if (pathname === '/runescape_bold.woff2') {
				try {
					const font = fs.readFileSync(fontPath);
					res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' }).end(font);
				} catch (_) {
					res.writeHead(404).end('Not found');
				}
			} else if (pathname === '/api/stats') {
				const data = JSON.stringify(collector.getLiveStats(clients, worldClients, usernameToClientIds));
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(data);
			} else if (pathname === '/api/history') {
				const data = JSON.stringify(collector.getHistory());
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(data);
			} else {
				res.writeHead(404).end('Not found');
			}
		};

		statsWss = new WebSocket.Server({ noServer: true });

		statsWss.on('connection', (ws) => {
			// Send immediate snapshot on connect
			const payload = JSON.stringify(collector.getLiveStats(clients, worldClients, usernameToClientIds));
			if (ws.readyState === WebSocket.OPEN) ws.send(payload);
		});

		// Broadcast live stats to all connected stats clients every 5s
		statsTickInterval = setInterval(() => {
			if (statsWss.clients.size === 0) return;
			const payload = JSON.stringify(collector.getLiveStats(clients, worldClients, usernameToClientIds));
			for (const ws of statsWss.clients) {
				if (ws.readyState === WebSocket.OPEN) ws.send(payload);
			}
		}, 5000);

		if (statsPort === port) {
			// Single-port mode: game WS and stats dashboard share one port.
			// Plugin clients connect to ws://host:port (path /)
			// Stats dashboard connects to ws://host:port/stats
			statsHttpServer = http.createServer(statsHttpHandler);
			statsHttpServer.on('upgrade', (req, socket, head) => {
				const pathname = url.parse(req.url).pathname;
				if (pathname === '/stats') {
					statsWss.handleUpgrade(req, socket, head, (ws) => statsWss.emit('connection', ws));
				} else {
					wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
				}
			});
			statsHttpServer.listen(port, () => {
				console.log(`TileWhisper relay + stats dashboard listening on port ${port}`);
			});
		} else {
			// Dual-port mode: game WS on port, stats dashboard on statsPort
			statsHttpServer = http.createServer(statsHttpHandler);
			statsHttpServer.on('upgrade', (req, socket, head) => {
				if (url.parse(req.url).pathname === '/stats') {
					statsWss.handleUpgrade(req, socket, head, (ws) => statsWss.emit('connection', ws));
				} else {
					socket.destroy();
				}
			});
			statsHttpServer.listen(statsPort, () => {
				console.log(`TileWhisper stats dashboard listening on port ${statsPort}`);
			});
		}
	}

	wss.on('close', () => {
		clearInterval(heartbeat);
		clearInterval(snapshotInterval);
		if (statsTickInterval) clearInterval(statsTickInterval);
		if (statsWss) statsWss.close();
		if (statsHttpServer) statsHttpServer.close();
	});

	return wss;
}

// ========================================================================
// Entrypoint
// ========================================================================

if (require.main === module) {
	const PORT = parseInt(process.env.PORT || '8080', 10);
	const STATS_PORT = process.env.STATS_PORT ? parseInt(process.env.STATS_PORT, 10) : null;
	createServer({ port: PORT, statsPort: STATS_PORT });
	if (!STATS_PORT || STATS_PORT !== PORT) {
		console.log(`TileWhisper relay server listening on port ${PORT}`);
	}

	process.on('SIGINT', () => {
		console.log('Shutting down...');
		process.exit(0);
	});
}

module.exports = { createServer, parseAudioPacket, chebyshevDistance, distance3D, isValidUsername, isValidCoordinate, isValidPlane, isValidWorld };
