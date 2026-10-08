/** Viewer-only amplification. Never changes or stops the received media tracks. */
export function createStreamVolume(video, onChange, onError) {
	let level = Math.round(video.volume * 100);
	let muted = video.muted;
	let lastLevel = level || 100;
	let stream = null;
	let context = null;
	let gain = null;
	let source = null;
	let sourceTrack = null;
	let disposed = false;

	function ensureContext() {
		if (!context) {
			context = new AudioContext({ latencyHint: "interactive" });
			gain = context.createGain();
			gain.gain.value = 0;
			gain.connect(context.destination);
		}
		if (context.state === "suspended") void context.resume().catch(onError);
	}

	function refreshSource() {
		const track = stream?.getAudioTracks().find((track) => track.readyState === "live") || null;
		if (track === sourceTrack) return;
		sourceTrack?.removeEventListener("ended", refresh);
		source?.disconnect();
		source = null;
		sourceTrack = track;
		if (track) {
			source = context.createMediaStreamSource(new MediaStream([track]));
			source.connect(gain);
			track.addEventListener("ended", refresh);
		}
	}

	function apply() {
		if (disposed) return;
		try {
			if (level > 100) ensureContext();
			if (context) refreshSource();
			const boosted = level > 100 && Boolean(source);
			// Only one playback path is audible. Below 100% the video retains its
			// native volume/mute behavior; above it the gain node plays the audio.
			video.volume = Math.min(level / 100, 1);
			video.muted = muted || level === 0 || boosted;
			if (gain) {
				gain.gain.cancelScheduledValues(context.currentTime);
				if (boosted && !muted) gain.gain.setTargetAtTime(level / 100, context.currentTime, 0.015);
				else gain.gain.setValueAtTime(0, context.currentTime);
			}
		} catch (error) {
			level = Math.min(level, 100);
			video.volume = level / 100;
			video.muted = muted;
			onError(error);
		}
		onChange();
	}
	function refresh() { apply(); }
	const changed = () => {
		if (disposed || level > 100) return;
		level = Math.round(video.volume * 100);
		muted = video.muted;
		if (level > 0) lastLevel = level;
		onChange();
	};
	video.addEventListener("volumechange", changed);
	return {
		get level() { return level; },
		get silent() { return muted || level === 0; },
		setVolume(percent) {
			level = Math.max(0, Math.min(300, Number(percent) || 0));
			muted = level === 0;
			if (level > 0) lastLevel = level;
			apply();
		},
		toggleMute() {
			if (muted || level === 0) { if (level === 0) level = lastLevel; muted = false; }
			else muted = true;
			apply();
		},
		setStream(next) {
			if (next === stream) return;
			stream?.removeEventListener("addtrack", refresh);
			stream?.removeEventListener("removetrack", refresh);
			stream = next;
			stream?.addEventListener("addtrack", refresh);
			stream?.addEventListener("removetrack", refresh);
			refresh();
		},
		dispose() {
			disposed = true;
			video.removeEventListener("volumechange", changed);
			stream?.removeEventListener("addtrack", refresh);
			stream?.removeEventListener("removetrack", refresh);
			sourceTrack?.removeEventListener("ended", refresh);
			source?.disconnect();
			gain?.disconnect();
			if (context && context.state !== "closed") void context.close().catch(() => {});
		},
	};
}
