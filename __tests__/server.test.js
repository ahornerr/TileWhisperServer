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
		ws.on('open', () => resolve(ws));
		ws.on('error', err => reject(err));
	});
}

function nextMessage(ws, timeout = 1000) {
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (fn) => { if (!done) { done = true; fn(); } };
		const timer = setTimeout(() => finish(() => reject(new Error(`Timeout waiting ${timeout}ms`))), timeout);
		ws.once('message', (data) => finish(() => { clearTimeout(timer); resolve(data); }));
		ws.once('error', () => finish(() => { clearTimeout(timer); reject(new Error('WebSocket error')); }));
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
	const buf = Buffer.alloc(14 + usernameBytes.length + audioLen);
	buf.writeUInt32LE(world >>> 0, 0);
	buf.writeUInt32LE(x >>> 0, 4);
	buf.writeUInt32LE(y >>> 0, 8);
	buf.writeUInt8(plane, 12);
	buf.writeUInt8(usernameBytes.length, 13);
	usernameBytes.copy(buf, 14);
	return buf;
}

// ============================================================================
// parseAudioPacket unit tests
// ============================================================================

describe('parseAudioPacket', () => {
	it('parses a valid packet', () => {
		const buf = buildAudioBuffer({ world: 301, x: 3200, y: 3200, plane: 0, username: 'Alice', audioLen: 10 });
		expect(parseAudioPacket(buf)).toEqual({ world: 301, x: 3200, y: 3200, plane: 0, username: 'Alice' });
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
		expect(parseAudioPacket(buf)).toEqual({ world: 0, x: 0, y: 0, plane: 0, username: 'Bob' });
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
		sendPresence(b, { username: 'Bob', world: 400, x: 3205, y: 3205 });

		// Collect nearby messages
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

		// Build a valid audio packet at exactly the limit: 14 header + username + audio
		const username = 'Alice';
		const audioLen = 300 - 14 - username.length; // exactly 300 total
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
});
