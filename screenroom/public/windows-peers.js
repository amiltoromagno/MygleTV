import { Peer } from "./peers.js";
import { normalizeQuality } from "./share-quality.js";

export class WindowsPeer extends Peer {
	constructor(options) {
		super(options);
		this.quality = normalizeQuality(options.quality);
		this.parameterUpdates = Promise.resolve();
		this.pc.addEventListener("connectionstatechange", () => {
			if (this.pc.connectionState === "connected") this.applyScreenParameters().catch(console.warn);
		});
	}
	async accept(data) {
		await super.accept(data);
		if (data.description) await this.applyScreenParameters().catch(console.warn);
	}
	async setQuality(quality) {
		this.quality = normalizeQuality(quality);
		await this.applyScreenParameters();
	}
	applyScreenParameters() {
		const update = this.parameterUpdates.then(async () => {
			if (this.closed) return;
			const params = this.videoSender.getParameters();
			if (!params.encodings?.length) return; // Retried after negotiation.
			for (const encoding of params.encodings) {
				encoding.maxBitrate = this.quality.bitrate * 1_000_000;
				encoding.maxFramerate = this.quality.fps;
				encoding.priority = "high";
			}
			params.degradationPreference = this.quality.fps === 30 ? "maintain-resolution" : "balanced";
			await this.videoSender.setParameters(params);
		});
		this.parameterUpdates = update.catch(() => {});
		return update;
	}
}
