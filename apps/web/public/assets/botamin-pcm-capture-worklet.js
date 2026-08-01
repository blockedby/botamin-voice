class BotaminPcmCapture extends AudioWorkletProcessor {
	process(inputs) {
		const channels = inputs[0];
		if (!channels || channels.length === 0 || channels[0].length === 0) {
			return true;
		}
		const mono = new Float32Array(channels[0].length);
		for (let channel = 0; channel < channels.length; channel += 1) {
			const values = channels[channel];
			for (let index = 0; index < mono.length; index += 1) {
				mono[index] += values[index] / channels.length;
			}
		}
		this.port.postMessage(mono, [mono.buffer]);
		return true;
	}
}

registerProcessor("botamin-pcm-capture", BotaminPcmCapture);
