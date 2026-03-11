'use strict';

const { StatsCollector } = require('../stats');

function makeClients(count, withUsername = false) {
	const clients = new Map();
	for (let i = 0; i < count; i++) {
		clients.set(String(i), { username: withUsername ? `User${i}` : '', world: 0 });
	}
	return clients;
}

function makeWorldClients(worlds) {
	const m = new Map();
	for (const [world, ids] of Object.entries(worlds)) {
		m.set(Number(world), new Set(ids));
	}
	return m;
}

function makeUsernameMap(names) {
	const m = new Map();
	for (const name of names) {
		m.set(name, new Set([name]));
	}
	return m;
}

describe('StatsCollector: event counters', () => {
	it('counts audio frames forwarded and bytes', () => {
		const c = new StatsCollector();
		c.onAudioFrameForwarded(100);
		c.onAudioFrameForwarded(200);
		expect(c._audioFramesForwarded).toBe(2);
		expect(c._bandwidthBytesOut).toBe(300);
	});

	it('counts audio frames dropped', () => {
		const c = new StatsCollector();
		c.onAudioFrameDropped();
		c.onAudioFrameDropped();
		expect(c._audioFramesDropped).toBe(2);
	});

	it('counts connection rejections', () => {
		const c = new StatsCollector();
		c.onConnectionRejected('server_full');
		c.onConnectionRejected('ip_limit');
		c.onConnectionRejected('username_limit');
		expect(c._connectionsRejected).toBe(3);
	});

	it('onConnectionAccepted and onConnectionClosed are no-ops (no error)', () => {
		const c = new StatsCollector();
		expect(() => {
			c.onConnectionAccepted();
			c.onConnectionClosed();
			c.onPresenceProcessed();
		}).not.toThrow();
	});
});

describe('StatsCollector: snapshot', () => {
	it('captures current client count', () => {
		const c = new StatsCollector();
		const clients = makeClients(5, false);
		const point = c.snapshot(clients, new Map(), new Map());
		expect(point.totalConnections).toBe(5);
		expect(point.authenticatedConnections).toBe(0);
	});

	it('counts authenticated connections (clients with username)', () => {
		const c = new StatsCollector();
		const clients = makeClients(4, true);
		// Make 2 unauthenticated
		clients.get('0').username = '';
		clients.get('1').username = '';
		const point = c.snapshot(clients, new Map(), new Map());
		expect(point.totalConnections).toBe(4);
		expect(point.authenticatedConnections).toBe(2);
	});

	it('captures world count and username count', () => {
		const c = new StatsCollector();
		const worldClients = makeWorldClients({ 301: ['a', 'b'], 302: ['c'] });
		const usernameMap = makeUsernameMap(['Alice', 'Bob']);
		const point = c.snapshot(new Map(), worldClients, usernameMap);
		expect(point.activeWorlds).toBe(2);
		expect(point.uniqueUsernames).toBe(2);
	});

	it('computes delta for audio frames and bandwidth', () => {
		const c = new StatsCollector();
		c.onAudioFrameForwarded(100);
		c.onAudioFrameForwarded(200);
		c.onAudioFrameDropped();

		const p1 = c.snapshot(new Map(), new Map(), new Map());
		expect(p1.audioFramesForwarded).toBe(2);
		expect(p1.audioFramesDropped).toBe(1);
		expect(p1.estimatedBandwidthBytesOut).toBe(300);

		// Second snapshot with no new frames
		const p2 = c.snapshot(new Map(), new Map(), new Map());
		expect(p2.audioFramesForwarded).toBe(0);
		expect(p2.audioFramesDropped).toBe(0);
		expect(p2.estimatedBandwidthBytesOut).toBe(0);

		// Third snapshot with new activity
		c.onAudioFrameForwarded(50);
		const p3 = c.snapshot(new Map(), new Map(), new Map());
		expect(p3.audioFramesForwarded).toBe(1);
		expect(p3.estimatedBandwidthBytesOut).toBe(50);
	});

	it('computes delta for connectionsRejected', () => {
		const c = new StatsCollector();
		c.onConnectionRejected('server_full');
		c.onConnectionRejected('server_full');

		const p1 = c.snapshot(new Map(), new Map(), new Map());
		expect(p1.connectionsRejected).toBe(2);

		const p2 = c.snapshot(new Map(), new Map(), new Map());
		expect(p2.connectionsRejected).toBe(0);
	});

	it('snapshot includes a timestamp', () => {
		const c = new StatsCollector();
		const before = Date.now();
		const point = c.snapshot(new Map(), new Map(), new Map());
		const after = Date.now();
		expect(point.timestamp).toBeGreaterThanOrEqual(before);
		expect(point.timestamp).toBeLessThanOrEqual(after);
	});
});

describe('StatsCollector: ring buffer / getHistory', () => {
	it('returns empty array before any snapshots', () => {
		const c = new StatsCollector();
		expect(c.getHistory()).toEqual([]);
	});

	it('returns snapshots in chronological order', () => {
		const c = new StatsCollector({ historyMinutes: 5 });
		for (let i = 0; i < 3; i++) {
			const clients = makeClients(i);
			c.snapshot(clients, new Map(), new Map());
		}
		const h = c.getHistory();
		expect(h).toHaveLength(3);
		expect(h[0].totalConnections).toBe(0);
		expect(h[1].totalConnections).toBe(1);
		expect(h[2].totalConnections).toBe(2);
	});

	it('evicts oldest entry when capacity is exceeded', () => {
		const c = new StatsCollector({ historyMinutes: 3 });
		for (let i = 0; i < 4; i++) {
			c.snapshot(makeClients(i), new Map(), new Map());
		}
		const h = c.getHistory();
		expect(h).toHaveLength(3);
		// Oldest (count=0) should be evicted; remaining: 1,2,3
		expect(h[0].totalConnections).toBe(1);
		expect(h[2].totalConnections).toBe(3);
	});

	it('handles exactly capacity entries without wrap', () => {
		const c = new StatsCollector({ historyMinutes: 3 });
		for (let i = 0; i < 3; i++) {
			c.snapshot(makeClients(i), new Map(), new Map());
		}
		const h = c.getHistory();
		expect(h).toHaveLength(3);
		expect(h[0].totalConnections).toBe(0);
		expect(h[2].totalConnections).toBe(2);
	});

	it('continues correct order after multiple full wraps', () => {
		const cap = 4;
		const c = new StatsCollector({ historyMinutes: cap });
		for (let i = 0; i < cap * 3; i++) {
			c.snapshot(makeClients(i), new Map(), new Map());
		}
		const h = c.getHistory();
		expect(h).toHaveLength(cap);
		// Last `cap` entries: indices cap*3-cap .. cap*3-1
		const base = cap * 3 - cap;
		for (let i = 0; i < cap; i++) {
			expect(h[i].totalConnections).toBe(base + i);
		}
	});
});

describe('StatsCollector: getLiveStats', () => {
	it('returns live totals and worldPlayerCounts', () => {
		const c = new StatsCollector();
		c.onAudioFrameForwarded(500);
		c.onAudioFrameDropped();
		c.onConnectionRejected('ip_limit');

		const clients = makeClients(3, true);
		const worldClients = makeWorldClients({ 301: ['a', 'b'], 302: ['c'] });
		const usernameMap = makeUsernameMap(['A', 'B', 'C']);

		const s = c.getLiveStats(clients, worldClients, usernameMap);
		expect(s.totalConnections).toBe(3);
		expect(s.authenticatedConnections).toBe(3);
		expect(s.activeWorlds).toBe(2);
		expect(s.uniqueUsernames).toBe(3);
		expect(s.audioFramesForwardedTotal).toBe(1);
		expect(s.audioFramesDroppedTotal).toBe(1);
		expect(s.bandwidthBytesOutTotal).toBe(500);
		expect(s.connectionsRejectedTotal).toBe(1);
		expect(s.worldPlayerCounts[301]).toBe(2);
		expect(s.worldPlayerCounts[302]).toBe(1);
	});
});
