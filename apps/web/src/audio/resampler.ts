const INTEGER_EPSILON = 1e-10;

/** Stateful linear resampler that preserves phase across AudioWorklet blocks. */
export class StreamingLinearResampler {
	readonly inputSampleRate: number;
	readonly outputSampleRate: number;

	private readonly sourceStep: number;
	private buffered = new Float32Array(0);
	private nextSourcePosition = 0;

	constructor(inputSampleRate: number, outputSampleRate: number) {
		if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
			throw new RangeError("Input sample rate must be positive");
		}
		if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) {
			throw new RangeError("Output sample rate must be positive");
		}
		this.inputSampleRate = inputSampleRate;
		this.outputSampleRate = outputSampleRate;
		this.sourceStep = inputSampleRate / outputSampleRate;
	}

	push(input: Float32Array): Float32Array {
		if (!(input instanceof Float32Array)) {
			throw new TypeError("Resampler input must be Float32Array samples");
		}
		if (input.length === 0) return new Float32Array(0);

		const combined = new Float32Array(this.buffered.length + input.length);
		combined.set(this.buffered);
		combined.set(input, this.buffered.length);
		this.buffered = combined;

		const output: number[] = [];
		while (this.nextSourcePosition < this.buffered.length) {
			const leftIndex = Math.floor(this.nextSourcePosition);
			const fraction = this.nextSourcePosition - leftIndex;
			const isExactSample = Math.abs(fraction) < INTEGER_EPSILON;
			if (!isExactSample && leftIndex + 1 >= this.buffered.length) break;

			const left = this.buffered[leftIndex] ?? 0;
			const right = this.buffered[leftIndex + 1] ?? left;
			output.push(isExactSample ? left : left + (right - left) * fraction);
			this.nextSourcePosition += this.sourceStep;
		}

		const discardCount = Math.min(
			Math.floor(this.nextSourcePosition),
			this.buffered.length,
		);
		if (discardCount > 0) {
			this.buffered = this.buffered.slice(discardCount);
			this.nextSourcePosition -= discardCount;
		}

		return Float32Array.from(output);
	}

	reset(): void {
		this.buffered = new Float32Array(0);
		this.nextSourcePosition = 0;
	}
}

export function resampleLinear(
	input: Float32Array,
	inputSampleRate: number,
	outputSampleRate: number,
): Float32Array {
	return new StreamingLinearResampler(inputSampleRate, outputSampleRate).push(
		input,
	);
}
