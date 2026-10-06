import { PcmBuffer } from "./pcm-buffer.js";

class PcmSource extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buffer = new PcmBuffer(sampleRate);
		this.port.onmessage = ({ data }) => {
			if (data instanceof Uint8Array) this.buffer.push(data);
		};
	}
	process(_inputs, outputs) {
		this.buffer.process(outputs[0]);
		return true;
	}
}
registerProcessor("mygletv-pcm", PcmSource);
