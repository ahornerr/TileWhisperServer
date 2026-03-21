'use strict';

const WebSocket = require('ws');
const { createServer, parseAudioPacket, chebyshevDistance, distance3D } = require('../server');

// ============================================================================
// Helpers
// ============================================================================

function startServer(opts = {}) {
	const wss = createServer({ port: 0, ...opts });
	const port = wss.address().port;
	return { wss, port };
}

function connect(port) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		ws._msgQueue = [];
		ws._msgWaiters = [];
		ws.on('message', (data) => {
			if (ws._msgWaiters.length > 0) {
				ws._msgWaiters.shift()(data);
			} else {
				ws._msgQueue.push(data);
			}
		});
		ws.on('open', () => resolve(ws));
		ws.on('error', err => reject(err));
	});
}

function nextMessage(ws, timeout = 1000) {
	if (ws._msgQueue.length > 0) return Promise.resolve(ws._msgQueue.shift());
	return new Promise((resolve, reject) => {
		let done = false;
		const timer = setTimeout(() => {
			if (done) return; done = true;
			const i = ws._msgWaiters.indexOf(waiter);
			if (i >= 0) ws._msgWaiters.splice(i, 1);
			reject(new Error(`Timeout waiting ${timeout}ms`));
		}, timeout);
		const waiter = (data) => { if (done) return; done = true; clearTimeout(timer); resolve(data); };
		ws._msgWaiters.push(waiter);
	});
}

function closeAllAndWait(clients) {
	return Promise.all(clients.map(ws => {
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
			return new Promise(resolve => { ws.once('close', resolve); ws.close(); });
		}
		return Promise.resolve();
	}));
}

function sendPresence(ws, opts = {}) {
	const { world = 301, x = 3200, y = 3200, plane = 0, username = 'Player' } = opts;
	ws.send(JSON.stringify({ type: 'presence', world, x, y, plane, username }));
}

function buildAudioBuffer(opts = {}) {
	const { world = 301, x = 3200, y = 3200, plane = 0, username = 'Player', audioLen = 10 } = opts;
	const usernameBytes = Buffer.from(username, 'utf8');
	// Layout: [world:4][x:4][y:4][plane:1][usernameLen:1][username:N][timestampSec:4][audio:M]
	const buf = Buffer.alloc(14 + usernameBytes.length + 4 + audioLen);
	buf.writeUInt32LE(world >>> 0, 0);
	buf.writeUInt32LE(x >>> 0, 4);
	buf.writeUInt32LE(y >>> 0, 8);
	buf.writeUInt8(plane, 12);
	buf.writeUInt8(usernameBytes.length, 13);
	usernameBytes.copy(buf, 14);
	buf.writeUInt32LE(Math.floor(Date.now() / 1000), 14 + usernameBytes.length);
	return buf;
}

// ============================================================================
// parseAudioPacket unit tests
// ============================================================================

describe('parseAudioPacket', () => {
	it('parses a valid packet', () => {
		const buf = buildAudioBuffer({ world: 301, x: 3200, y: 3200, plane: 0, username: 'Alice', audioLen: 10 });
		expect(parseAudioPacket(buf)).toEqual({ world: 301, x: 3200, y: 3200, plane: 0, username: 'Alice', timestampSec: expect.any(Number) });
	});

	it('parses a single-char username', () => {
		const buf = buildAudioBuffer({ username: 'A', audioLen: 0 });
		expect(parseAudioPacket(buf).username).toBe('A');
	});

	it('parses a 12-char username', () => {
		const buf = buildAudioBuffer({ username: 'TwelveCharsX', audioLen: 0 });
		expect(parseAudioPacket(buf).username).toBe('TwelveCharsX');
	});

	it('returns null for buffer shorter than header', () => {
		expect(parseAudioPacket(Buffer.alloc(13))).toBeNull();
	});

	it('returns null when username length exceeds buffer', () => {
		const buf = Buffer.alloc(16 + 5);
		buf.writeUInt8(10, 13); // claims 10 chars but only 5 follow
		expect(parseAudioPacket(buf)).toBeNull();
	});

	it('handles zero values', () => {
		const buf = buildAudioBuffer({ world: 0, x: 0, y: 0, plane: 0, username: 'Bob' });
		expect(parseAudioPacket(buf)).toEqual({ world: 0, x: 0, y: 0, plane: 0, username: 'Bob', timestampSec: expect.any(Number) });
	});

	it('handles max int32 world value', () => {
		const buf = buildAudioBuffer({ world: 0x7FFFFFFF, username: 'P' });
		expect(parseAudioPacket(buf).world).toBe(0x7FFFFFFF);
	});

	it('handles plane 0-3', () => {
		for (let plane = 0; plane <= 3; plane++) {
			const buf = buildAudioBuffer({ plane, username: 'P', audioLen: 0 });
			expect(parseAudioPacket(buf).plane).toBe(plane);
		}
	});

	it('handles large OSRS coordinates', () => {
		const buf = buildAudioBuffer({ x: 16383, y: 16383, username: 'Max' });
		const result = parseAudioPacket(buf);
		expect(result.x).toBe(16383);
		expect(result.y).toBe(16383);
	});
});

// ============================================================================
// Distance calculation unit tests
// ============================================================================

describe('chebyshevDistance', () => {
	it('is 0 for same tile', () => {
		expect(chebyshevDistance(3200, 3200, 3200, 3200)).toBe(0);
	});

	it('is x difference when dx > dy', () => {
		expect(chebyshevDistance(3200, 3200, 3215, 3205)).toBe(15);
	});

	it('is y difference when dy > dx', () => {
		expect(chebyshevDistance(3200, 3200, 3202, 3220)).toBe(20);
	});

	it('handles negative coordinates', () => {
		expect(chebyshevDistance(-10, -10, 10, 10)).toBe(20);
	});

	it('handles large map coordinates', () => {
		expect(chebyshevDistance(0, 0, 16383, 16383)).toBe(16383);
	});
});

describe('distance3D', () => {
	it('is 0 for same position and plane', () => {
		expect(distance3D(3200, 3200, 0, 3200, 3200, 0)).toBe(0);
	});

	it('is Infinity for different planes', () => {
		expect(distance3D(3200, 3200, 0, 3200, 3200, 1)).toBe(Infinity);
		expect(distance3D(3200, 3200, 1, 3200, 3200, 2)).toBe(Infinity);
	});

	it('uses chebyshev distance within same plane', () => {
		expect(distance3D(3200, 3200, 0, 3215, 3205, 0)).toBe(15);
	});
});

// ============================================================================
// Server integration tests — each test gets its own isolated server
// ============================================================================

describe('Server: welcome message', () => {
	it('sends welcome on connect', async () => {
		const { wss, port } = startServer();
		const ws = await connect(port);
		const msg = JSON.parse(await nextMessage(ws));
		expect(msg.type).toBe('welcome');
		await closeAllAndWait([ws]);
		wss.close();
	});
});

describe('Server: presence and nearby', () => {
	it('sends nearby list after presence', async () => {
		const { wss, port } = startServer();
		const ws = await connect(port);
		await nextMessage(ws); // welcome
		sendPresence(ws, { username: 'Alice' });
		const msg = JSON.parse(await nextMessage(ws));
		expect(msg.type).toBe('nearby');
		expect(Array.isArray(msg.players)).toBe(true);
		await closeAllAndWait([ws]);
		wss.close();
	});

	it('two nearby players see each other', async () => {
		const { wss, port } = startServer();
		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 400, x: 3200, y: 3200 });
		await nextMessage(a); // drain Alice's nearby before Bob joins
		sendPresence(b, { username: 'Bob', world: 400, x: 3205, y: 3205 });

		// Collect nearby messages sent when both players are in the world
		const msgs = await Promise.all([nextMessage(a), nextMessage(b)]);
		const playerNames = msgs.flatMap(d => JSON.parse(d).players.map(p => p.username));
		expect(playerNames).toContain('Alice');
		expect(playerNames).toContain('Bob');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('players on different worlds do not see each other', async () => {
		const { wss, port } = startServer();
		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 301, x: 3200, y: 3200 });
		const msgA = JSON.parse(await nextMessage(a));
		expect(msgA.players.map(p => p.username)).not.toContain('Bob');

		sendPresence(b, { username: 'Bob', world: 302, x: 3200, y: 3200 });
		const msgB = JSON.parse(await nextMessage(b));
		expect(msgB.players.map(p => p.username)).not.toContain('Alice');

		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('players on different planes do not see each other', async () => {
		const { wss, port } = startServer();
		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 401, x: 3200, y: 3200, plane: 0 });
		const msgA = JSON.parse(await nextMessage(a));
		expect(msgA.players.map(p => p.username)).not.toContain('Bob');

		sendPresence(b, { username: 'Bob', world: 401, x: 3200, y: 3200, plane: 1 });
		const msgB = JSON.parse(await nextMessage(b));
		expect(msgB.players.map(p => p.username)).not.toContain('Alice');

		await closeAllAndWait([a, b]);
		wss.close();
	});
});

describe('Server: audio forwarding', () => {
	it('forwards audio to nearby player on same world and plane', async () => {
		const { wss, port } = startServer();
		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 500, x: 3200, y: 3200, plane: 0 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 500, x: 3200, y: 3200, plane: 0 });
		await nextMessage(b);
		await nextMessage(a); // a also gets updated nearby when b joins

		const audio = buildAudioBuffer({ world: 500, x: 3200, y: 3200, plane: 0, username: 'Alice' });
		a.send(audio);

		const received = await nextMessage(b, 500);
		expect(Buffer.isBuffer(received)).toBe(true);
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('does not forward audio to player on different world', async () => {
		const { wss, port } = startServer();
		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 501, x: 3200, y: 3200, plane: 0 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 502, x: 3200, y: 3200, plane: 0 });
		await nextMessage(b);

		const audio = buildAudioBuffer({ world: 501, x: 3200, y: 3200, plane: 0, username: 'Alice' });
		a.send(audio);

		await expect(nextMessage(b, 400)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('does not forward audio to player out of range (>50 tiles)', async () => {
		const { wss, port } = startServer();
		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 503, x: 3200, y: 3200, plane: 0 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 503, x: 3000, y: 3000, plane: 0 }); // 200 tiles away
		await nextMessage(b);

		const audio = buildAudioBuffer({ world: 503, x: 3200, y: 3200, plane: 0, username: 'Alice' });
		a.send(audio);

		await expect(nextMessage(b, 400)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('does not forward audio to player on different plane', async () => {
		const { wss, port } = startServer();
		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 504, x: 3200, y: 3200, plane: 0 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 504, x: 3200, y: 3200, plane: 1 });
		await nextMessage(b);

		const audio = buildAudioBuffer({ world: 504, x: 3200, y: 3200, plane: 0, username: 'Alice' });
		a.send(audio);

		await expect(nextMessage(b, 400)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});
});

describe('Server: rate limiting', () => {
	it('rejects connections beyond maxTotalConnections', async () => {
		const { wss, port } = startServer({ maxTotalConnections: 2 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		// Third connection (beyond global cap) should be rejected
		const c = new WebSocket(`ws://localhost:${port}`);
		const closeCode = await new Promise((resolve) => {
			c.on('close', (code) => resolve(code));
			c.on('error', () => resolve(-1)); // connection error also counts as rejected
		});
		expect(c.readyState).not.toBe(WebSocket.OPEN);

		await closeAllAndWait([a, b, c]);
		wss.close();
	});

	it('rejects connections beyond maxConnectionsPerIp', async () => {
		const { wss, port } = startServer({ maxConnectionsPerIp: 2 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		// Third connection from same IP should be rejected (closed immediately)
		const c = new WebSocket(`ws://localhost:${port}`);
		const closeCode = await new Promise((resolve) => {
			c.on('close', (code) => resolve(code));
			c.on('error', () => resolve(-1)); // connection error also counts as rejected
		});
		expect(c.readyState).not.toBe(WebSocket.OPEN);

		await closeAllAndWait([a, b, c]);
		wss.close();
	});

	it('rejects oversized binary payloads (does not forward to recipient)', async () => {
		const { wss, port } = startServer({ maxBinaryPayloadBytes: 100 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { world: 600, x: 3200, y: 3200 });
		await nextMessage(a);
		sendPresence(b, { world: 600, x: 3200, y: 3200 });
		await nextMessage(b);
		await nextMessage(a); // a gets nearby update when b joins

		const tooBig = Buffer.alloc(101);
		a.send(tooBig, { binary: true });

		// b should not receive the oversized packet
		await expect(nextMessage(b, 400)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('accepts binary payload exactly at the limit', async () => {
		const { wss, port } = startServer({ maxBinaryPayloadBytes: 300 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 601, x: 3200, y: 3200 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 601, x: 3200, y: 3200 });
		await nextMessage(b);
		await nextMessage(a); // a gets nearby update when b joins

		// Build a valid audio packet at exactly the limit: 14 header + username + 4 timestamp + audio
		const username = 'Alice';
		const audioLen = 300 - 14 - username.length - 4; // exactly 300 total
		const audio = buildAudioBuffer({ world: 601, x: 3200, y: 3200, username, audioLen });
		expect(audio.length).toBe(300);

		a.send(audio);

		const received = await nextMessage(b, 500);
		expect(Buffer.isBuffer(received)).toBe(true);
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('drops excess audio frames within the same second', async () => {
		const { wss, port } = startServer({ maxAudioFramesPerSec: 3 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 700, x: 3200, y: 3200 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 700, x: 3200, y: 3200 });
		await nextMessage(b);
		await nextMessage(a); // a gets nearby update when b joins

		const audio = buildAudioBuffer({ world: 700, x: 3200, y: 3200, username: 'Alice' });

		let binaryReceived = 0;
		b.on('message', (msg, isBinary) => { if (isBinary) binaryReceived++; });

		// Send 6 frames synchronously (all within the same window) — 3 should pass, 3 dropped
		for (let i = 0; i < 6; i++) a.send(audio);

		await new Promise(r => setTimeout(r, 300));

		expect(binaryReceived).toBeLessThanOrEqual(4); // at most 3 + tiny timing margin
		expect(binaryReceived).toBeGreaterThan(0);    // at least some passed

		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('drops excess presence messages within the same second', async () => {
		const { wss, port } = startServer({ maxPresencePerSec: 1 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		// Put b in world 800 first so it will receive broadcasts from a
		sendPresence(b, { username: 'Bob', world: 800, x: 3200, y: 3200 });
		await nextMessage(b); // b's own nearby update (no one else yet)

		// First presence from a: allowed — a and b both receive nearby updates
		sendPresence(a, { username: 'Alice', world: 800, x: 3200, y: 3200 });
		await nextMessage(a); // drain a's nearby
		const firstUpdate = JSON.parse(await nextMessage(b));
		expect(firstUpdate.type).toBe('nearby');

		// Second presence in the same second: should be dropped — b gets no further nearby update
		sendPresence(a, { username: 'Alice', world: 800, x: 3201, y: 3201 });
		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');

		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects oversized JSON payloads', async () => {
		const { wss, port } = startServer({ maxJsonPayloadBytes: 100 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		// Send a presence-like JSON message larger than 100 bytes
		const oversized = JSON.stringify({ type: 'presence', world: 301, x: 3200, y: 3200, plane: 0, username: 'A'.repeat(100) });
		expect(oversized.length).toBeGreaterThan(100);
		a.send(oversized);

		// b should not receive any nearby update triggered by the dropped message
		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');

		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects presence with invalid username (starts with number)', async () => {
		const { wss, port } = startServer();

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		sendPresence(b, { username: 'Bob', world: 900, x: 3200, y: 3200 });
		await nextMessage(b); // b's own nearby

		// Send presence with username starting with number
		a.send(JSON.stringify({ type: 'presence', world: 900, x: 3200, y: 3200, username: '1Player' }));

		// b should not receive nearby for invalid username
		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');

		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects presence with invalid username (too long)', async () => {
		const { wss, port } = startServer();

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		sendPresence(b, { username: 'Bob', world: 901, x: 3200, y: 3200 });
		await nextMessage(b);

		// Send presence with 13-character username
		a.send(JSON.stringify({ type: 'presence', world: 901, x: 3200, y: 3200, username: 'TooLongNameX' }));

		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects presence with invalid coordinate (negative)', async () => {
		const { wss, port } = startServer();

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		sendPresence(b, { username: 'Bob', world: 902, x: 3200, y: 3200 });
		await nextMessage(b);

		a.send(JSON.stringify({ type: 'presence', world: 902, x: -1, y: 3200, username: 'Alice' }));

		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects presence with invalid coordinate (exceeds max)', async () => {
		const { wss, port } = startServer();

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		sendPresence(b, { username: 'Bob', world: 903, x: 3200, y: 3200 });
		await nextMessage(b);

		a.send(JSON.stringify({ type: 'presence', world: 903, x: 16384, y: 3200, username: 'Alice' }));

		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects presence with invalid plane', async () => {
		const { wss, port } = startServer();

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		sendPresence(b, { username: 'Bob', world: 904, x: 3200, y: 3200 });
		await nextMessage(b);

		a.send(JSON.stringify({ type: 'presence', world: 904, x: 3200, y: 3200, plane: 4, username: 'Alice' }));

		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects presence with invalid world', async () => {
		const { wss, port } = startServer();

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		sendPresence(b, { username: 'Bob', world: 905, x: 3200, y: 3200 });
		await nextMessage(b);

		a.send(JSON.stringify({ type: 'presence', world: 0, x: 3200, y: 3200, username: 'Alice' }));

		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects presence from third connection with same username', async () => {
		// Allow 2 connections per username so a and b both get in, but c is rejected
		const { wss, port } = startServer({ maxConnectionsPerUsername: 2 });

		const [a, b, c] = await Promise.all([connect(port), connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		await nextMessage(c); // welcome

		sendPresence(a, { username: 'SameUser', world: 1000, x: 3200, y: 3200 });
		await nextMessage(a); // a gets nearby

		sendPresence(b, { username: 'SameUser', world: 1000, x: 3200, y: 3200 });
		await nextMessage(b); // b gets nearby
		await nextMessage(a); // a sees b arrive

		// Third connection with same username: presence rejected, no one gets update
		sendPresence(c, { username: 'SameUser', world: 1000, x: 3200, y: 3201 });

		await expect(nextMessage(a, 300)).rejects.toThrow('Timeout');
		await expect(nextMessage(b, 300)).rejects.toThrow('Timeout');
		await expect(nextMessage(c, 300)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b, c]);
		wss.close();
	});

	it('rejects audio packet with invalid username', async () => {
		const { wss, port } = startServer();

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		sendPresence(a, { username: 'Alice', world: 1100, x: 3200, y: 3200 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 1100, x: 3200, y: 3200 });
		await nextMessage(b);
		await nextMessage(a); // a gets nearby when b joins

		// Send audio with invalid username
		const audio = buildAudioBuffer({ world: 1100, x: 3200, y: 3200, username: '123Invalid' });
		a.send(audio);

		await expect(nextMessage(b, 400)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('rejects audio packet with invalid coordinates', async () => {
		const { wss, port } = startServer();

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome
		sendPresence(a, { username: 'Alice', world: 1200, x: 3200, y: 3200 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 1200, x: 3200, y: 3200 });
		await nextMessage(b);
		await nextMessage(a); // a gets nearby when b joins

		// Send audio with invalid coordinates
		const audio = buildAudioBuffer({ world: 1200, x: -5, y: 3200, username: 'Alice' });
		a.send(audio);

		await expect(nextMessage(b, 400)).rejects.toThrow('Timeout');
		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('detects and drops burst audio (30s window)', async () => {
		const { wss, port } = startServer({ maxAudioFramesPer30Sec: 5, maxAudioFramesPerSec: 1000 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(a, { username: 'Alice', world: 1300, x: 3200, y: 3200 });
		await nextMessage(a);
		sendPresence(b, { username: 'Bob', world: 1300, x: 3200, y: 3200 });
		await nextMessage(b);
		await nextMessage(a);

		const audio = buildAudioBuffer({ world: 1300, x: 3200, y: 3200, username: 'Alice' });

		let binaryReceived = 0;
		b.on('message', (msg, isBinary) => { if (isBinary) binaryReceived++; });

		// Send 10 frames synchronously — first 5 should pass, next 5 dropped due to burst limit
		for (let i = 0; i < 10; i++) a.send(audio);

		await new Promise(r => setTimeout(r, 300));

		expect(binaryReceived).toBeLessThanOrEqual(7); // at most 5 + tiny timing margin
		expect(binaryReceived).toBeGreaterThan(0); // at least some passed

		await closeAllAndWait([a, b]);
		wss.close();
	});

	it('detects and drops burst presence (30s window)', async () => {
		const { wss, port } = startServer({ maxPresencePer30Sec: 2, maxPresencePerSec: 100 });

		const [a, b] = await Promise.all([connect(port), connect(port)]);
		await nextMessage(a); // welcome
		await nextMessage(b); // welcome

		sendPresence(b, { username: 'Bob', world: 1400, x: 3200, y: 3200 });
		await nextMessage(b);

		let jsonReceived = 0;
		b.on('message', (msg, isBinary) => { if (!isBinary) jsonReceived++; });

		// Send 3 presence updates quickly (under per-second limit, over 30s limit)
		sendPresence(a, { username: 'Alice', world: 1400, x: 3200, y: 3200, plane: 0 });
		sendPresence(a, { username: 'Alice', world: 1400, x: 3200, y: 3200, plane: 0 });
		sendPresence(a, { username: 'Alice', world: 1400, x: 3200, y: 3200, plane: 0 });

		await new Promise(r => setTimeout(r, 300));

		// At most 2 should pass
		expect(jsonReceived).toBeLessThanOrEqual(4); // 2 updates × 2 notifications each
		expect(jsonReceived).toBeGreaterThan(0);

		await closeAllAndWait([a, b]);
		wss.close();
	});
});
