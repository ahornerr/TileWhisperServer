'use strict';

class StatsCollector {
	constructor({ historyMinutes = 1440 } = {}) {
		this.capacity = historyMinutes;
		this.buffer = new Array(this.capacity);
		this.writeIdx = 0;
		this.count = 0;

		// Running totals (never reset)
		this._audioFramesForwarded = 0;
		this._audioFramesDropped = 0;
		this._bandwidthBytesOut = 0;
		this._connectionsRejected = 0;

		// Last snapshot values (for delta calculation)
		this._lastAudioFramesForwarded = 0;
		this._lastAudioFramesDropped = 0;
		this._lastBandwidthBytesOut = 0;
		this._lastConnectionsRejected = 0;

		// Session duration tracking
		this._totalSessionDurationMs = 0;
		this._sessionCount = 0;

		// Latency tracking: rolling window of recent ping times
		this._latencyWindow = [];
		this._latencyWindowCapacity = 60; // Keep last 60 pings
	}

	onConnectionAccepted() {}

	onConnectionRejected(reason) {
		this._connectionsRejected++;
	}

	onConnectionClosed(durationMs) {
		if (Number.isFinite(durationMs) && durationMs >= 0) {
			this._totalSessionDurationMs += durationMs;
			this._sessionCount++;
		}
	}

	onPingLatency(ms) {
		if (Number.isFinite(ms) && ms >= 0) {
			this._latencyWindow.push(ms);
			if (this._latencyWindow.length > this._latencyWindowCapacity) {
				this._latencyWindow.shift();
			}
		}
	}

	onAudioFrameForwarded(bytes) {
		this._audioFramesForwarded++;
		this._bandwidthBytesOut += bytes;
	}

	onAudioFrameDropped() {
		this._audioFramesDropped++;
	}

	onPresenceProcessed() {}

	// Called every 60s by server.js
	snapshot(clients, worldClients, usernameToClientIds) {
		const audioFramesDelta = this._audioFramesForwarded - this._lastAudioFramesForwarded;
		const audioDroppedDelta = this._audioFramesDropped - this._lastAudioFramesDropped;
		const bandwidthDelta = this._bandwidthBytesOut - this._lastBandwidthBytesOut;
		const rejectedDelta = this._connectionsRejected - this._lastConnectionsRejected;

		this._lastAudioFramesForwarded = this._audioFramesForwarded;
		this._lastAudioFramesDropped = this._audioFramesDropped;
		this._lastBandwidthBytesOut = this._bandwidthBytesOut;
		this._lastConnectionsRejected = this._connectionsRejected;

		let authenticatedConnections = 0;
		for (const client of clients.values()) {
			if (client.username) authenticatedConnections++;
		}

		const point = {
			timestamp: Date.now(),
			totalConnections: clients.size,
			authenticatedConnections,
			activeWorlds: worldClients.size,
			uniqueUsernames: usernameToClientIds.size,
			audioFramesForwarded: audioFramesDelta,
			audioFramesDropped: audioDroppedDelta,
			estimatedBandwidthBytesOut: bandwidthDelta,
			connectionsRejected: rejectedDelta,
		};

		this.buffer[this.writeIdx % this.capacity] = point;
		this.writeIdx++;
		if (this.count < this.capacity) this.count++;

		return point;
	}

	// Instant totals from live Maps — called by stats HTTP endpoint
	getLiveStats(clients, worldClients, usernameToClientIds) {
		let authenticatedConnections = 0;
		const worldPlayerCounts = {};
		for (const client of clients.values()) {
			if (client.username) authenticatedConnections++;
		}
		for (const [world, set] of worldClients.entries()) {
			worldPlayerCounts[world] = set.size;
		}

		// Calculate average latency from window
		const avgLatencyMs = this._latencyWindow.length > 0
			? Math.round(this._latencyWindow.reduce((a, b) => a + b, 0) / this._latencyWindow.length)
			: 0;

		// Calculate connection quality as percentage of frames delivered
		const totalFrames = this._audioFramesForwarded + this._audioFramesDropped;
		const connectionQuality = totalFrames > 0
			? Math.round((this._audioFramesForwarded / totalFrames) * 100)
			: 100;

		return {
			timestamp: Date.now(),
			totalConnections: clients.size,
			authenticatedConnections,
			activeWorlds: worldClients.size,
			uniqueUsernames: usernameToClientIds.size,
			worldPlayerCounts,
			audioFramesForwardedTotal: this._audioFramesForwarded,
			audioFramesDroppedTotal: this._audioFramesDropped,
			bandwidthBytesOutTotal: this._bandwidthBytesOut,
			connectionsRejectedTotal: this._connectionsRejected,
			sessionCount: this._sessionCount,
			avgSessionDurationMs: this._sessionCount > 0
				? Math.round(this._totalSessionDurationMs / this._sessionCount)
				: 0,
			avgLatencyMs,
			connectionQuality,
		};
	}

	// Ring buffer as array, oldest-first
	getHistory() {
		if (this.count === 0) return [];

		const result = [];
		const startIdx = this.count < this.capacity ? 0 : this.writeIdx % this.capacity;

		for (let i = 0; i < this.count; i++) {
			result.push(this.buffer[(startIdx + i) % this.capacity]);
		}

		return result;
	}
}

module.exports = { StatsCollector };
