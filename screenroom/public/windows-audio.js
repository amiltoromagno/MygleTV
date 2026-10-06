let cleanup = null;

export async function stopWindowsAudio() {
	const stop = cleanup;
	cleanup = null;
	if (stop) await stop();
}

export async function captureWindowsAudio(bridge, description) {
	await stopWindowsAudio();
	if (description?.transport !== "pcm" || description.sampleRate !== 48000 || description.channels !== 2 || description.bitsPerSample !== 16) throw new Error("Unsupported Windows audio format.");
	const context = new AudioContext({ sampleRate: description.sampleRate, latencyHint: "interactive" });
	let unsubscribe = () => {};
	let node = null;
	let destination = null;
	const stop = async () => {
		unsubscribe();
		node?.disconnect();
		for (const track of destination?.stream.getTracks() || []) track.stop();
		if (context.state !== "closed") await context.close();
	};
	try {
		if (context.sampleRate !== description.sampleRate) throw new Error("Windows audio requires a 48 kHz audio context.");
		await context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
		node = new AudioWorkletNode(context, "mygletv-pcm", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
		destination = context.createMediaStreamDestination();
		node.connect(destination);
		unsubscribe = bridge.onPcm((message) => {
			if (message.captureId !== description.captureId) return;
			const source = message.pcm;
			const bytes = source instanceof Uint8Array ? new Uint8Array(source) : new Uint8Array(source?.data || source);
			if (!bytes.byteLength || bytes.byteLength > 192000 || bytes.byteLength % 4) return;
			node.port.postMessage(bytes, [bytes.buffer]);
		});
		await context.resume();
		cleanup = stop;
		return destination.stream;
	} catch (err) {
		await stop();
		throw err;
	}
}
