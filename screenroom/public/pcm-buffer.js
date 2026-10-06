/** Bounded stereo FIFO. Native silence gaps become silence, never old audio. */
export class PcmBuffer {
	constructor(sampleRate = 48000, targetMs = 60, maxMs = 200) {
		this.capacity = Math.ceil(sampleRate * maxMs / 1000);
		this.target = Math.ceil(sampleRate * targetMs / 1000);
		this.left = new Float32Array(this.capacity);
		this.right = new Float32Array(this.capacity);
		this.read = 0;
		this.write = 0;
		this.length = 0;
		this.started = false;
	}
	push(bytes) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let offset = 0; offset + 3 < bytes.byteLength; offset += 4) {
			if (this.length === this.capacity) {
				this.read = (this.read + 1) % this.capacity;
				this.length--;
			}
			this.left[this.write] = view.getInt16(offset, true) / 32768;
			this.right[this.write] = view.getInt16(offset + 2, true) / 32768;
			this.write = (this.write + 1) % this.capacity;
			this.length++;
		}
	}
	process(channels) {
		for (const channel of channels) channel.fill(0);
		if (!channels.length) return;
		if (!this.started && this.length < this.target) return;
		this.started = true;
		const count = Math.min(channels[0].length, this.length);
		for (let i = 0; i < count; i++) {
			channels[0][i] = this.left[this.read];
			if (channels[1]) channels[1][i] = this.right[this.read];
			this.read = (this.read + 1) % this.capacity;
		}
		this.length -= count;
		if (count < channels[0].length) this.started = false;
	}
}
