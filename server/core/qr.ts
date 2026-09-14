/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, versions 1–10, all four error-correction
 * levels, automatic mask selection. Pure (no imports, no Node APIs) so the web app imports it by
 * relative path like `protocol.ts`, and `qr.smoke.ts` exercises it on the hub.
 *
 * Used for the station join posters (Admin → Stations → QR). A join URL is ~100 characters, which
 * lands on version 6–7 at level M; anything past version 10 (213 bytes at M) throws.
 */

export type EcLevel = "L" | "M" | "Q" | "H";

export interface QrMatrix {
	version: number;
	/** Modules per side (17 + 4·version). */
	size: number;
	/** Row-major `size × size`; 1 = dark. Quiet zone not included. */
	modules: Uint8Array;
	ec: EcLevel;
	mask: number;
}

export interface QrOptions {
	/** Default "M" (15 % recovery). */
	ec?: EcLevel;
	/** Smallest version to use (1–10); the encoder still grows the version when the text needs it. */
	minVersion?: number;
}

const MAX_VERSION = 10;
/** Format-information bits for each level (ISO 18004 table 12). */
const EC_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Per version and level: error-correction codewords per block and the block layout `[count, dataCodewords][]`. */
const BLOCKS: Record<EcLevel, [ec: number, groups: [count: number, data: number][]][]> = {
	L: [
		[7, [[1, 19]]],
		[10, [[1, 34]]],
		[15, [[1, 55]]],
		[20, [[1, 80]]],
		[26, [[1, 108]]],
		[18, [[2, 68]]],
		[20, [[2, 78]]],
		[24, [[2, 97]]],
		[30, [[2, 116]]],
		[18, [[2, 68], [2, 69]]],
	],
	M: [
		[10, [[1, 16]]],
		[16, [[1, 28]]],
		[26, [[1, 44]]],
		[18, [[2, 32]]],
		[24, [[2, 43]]],
		[16, [[4, 27]]],
		[18, [[4, 31]]],
		[22, [[2, 38], [2, 39]]],
		[22, [[3, 36], [2, 37]]],
		[26, [[4, 43], [1, 44]]],
	],
	Q: [
		[13, [[1, 13]]],
		[22, [[1, 22]]],
		[18, [[2, 17]]],
		[26, [[2, 24]]],
		[18, [[2, 15], [2, 16]]],
		[24, [[4, 19]]],
		[18, [[2, 14], [4, 15]]],
		[22, [[4, 18], [2, 19]]],
		[20, [[4, 16], [4, 17]]],
		[24, [[6, 19], [2, 20]]],
	],
	H: [
		[17, [[1, 9]]],
		[28, [[1, 16]]],
		[22, [[2, 13]]],
		[16, [[4, 9]]],
		[22, [[2, 11], [2, 12]]],
		[28, [[4, 15]]],
		[26, [[4, 13], [1, 14]]],
		[26, [[4, 14], [2, 15]]],
		[24, [[4, 12], [4, 13]]],
		[28, [[6, 15], [2, 16]]],
	],
};

/** Alignment-pattern centre coordinates per version (index 0 = version 1, which has none). */
const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// ------------------------------------------------------------------ GF(256) Reed–Solomon

function gfMul(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

/** Generator polynomial coefficients (without the leading 1) for `degree` EC codewords. */
function rsGenerator(degree: number): number[] {
	const coef = new Array<number>(degree).fill(0);
	coef[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			coef[j] = gfMul(coef[j], root);
			if (j + 1 < degree) coef[j] ^= coef[j + 1];
		}
		root = gfMul(root, 2);
	}
	return coef;
}

/** The `ecCount` Reed–Solomon codewords for one block of data codewords. */
export function rsEncode(data: number[], ecCount: number): number[] {
	const gen = rsGenerator(ecCount);
	const out = new Array<number>(ecCount).fill(0);
	for (const b of data) {
		const factor = (b ^ out[0]) & 0xff;
		out.shift();
		out.push(0);
		for (let i = 0; i < ecCount; i++) out[i] ^= gfMul(gen[i], factor);
	}
	return out;
}

// ------------------------------------------------------------------ capacity / bit stream

function dataCodewords(version: number, ec: EcLevel): number {
	return BLOCKS[ec][version - 1][1].reduce((n, [count, data]) => n + count * data, 0);
}

/** Byte-mode character-count width: 8 bits up to version 9, 16 from version 10. */
const countBits = (version: number): number => (version <= 9 ? 8 : 16);

/** Largest byte payload version `v` holds at level `ec`. */
export function byteCapacity(version: number, ec: EcLevel): number {
	return Math.floor((dataCodewords(version, ec) * 8 - 4 - countBits(version)) / 8);
}

/** Smallest version (≥ `minVersion`) that holds `bytes` at level `ec`; throws RangeError past version 10. */
export function chooseVersion(bytes: number, ec: EcLevel = "M", minVersion = 1): number {
	for (let v = Math.max(1, minVersion); v <= MAX_VERSION; v++) if (byteCapacity(v, ec) >= bytes) return v;
	throw new RangeError(`text too long for a QR code up to version ${MAX_VERSION} at level ${ec} (${bytes} bytes)`);
}

function utf8(text: string): number[] {
	// TextEncoder exists in browsers and Node ≥ 11; kept behind a manual fallback so the module stays dependency-free.
	if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
	const out: number[] = [];
	for (const ch of unescape(encodeURIComponent(text))) out.push(ch.charCodeAt(0));
	return out;
}

class BitBuffer {
	readonly bits: number[] = [];
	push(value: number, width: number): void {
		for (let i = width - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
	}
	toBytes(): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.bits.length; i += 8) {
			let b = 0;
			for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0);
			out.push(b);
		}
		return out;
	}
}

/** Data codewords for `bytes` at `version`/`ec`: mode, count, payload, terminator, byte padding, 0xEC/0x11 fill. */
function buildCodewords(bytes: number[], version: number, ec: EcLevel): number[] {
	const capacity = dataCodewords(version, ec) * 8;
	const bb = new BitBuffer();
	bb.push(0b0100, 4);
	bb.push(bytes.length, countBits(version));
	for (const b of bytes) bb.push(b, 8);
	bb.push(0, Math.min(4, capacity - bb.bits.length));
	while (bb.bits.length % 8 !== 0) bb.bits.push(0);
	const out = bb.toBytes();
	for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
	return out;
}

/** Split into blocks, append EC per block, interleave data then EC (ISO 18004 §7.6). */
function interleave(codewords: number[], version: number, ec: EcLevel): number[] {
	const [ecCount, groups] = BLOCKS[ec][version - 1];
	const dataBlocks: number[][] = [];
	const ecBlocks: number[][] = [];
	let at = 0;
	for (const [count, len] of groups) {
		for (let i = 0; i < count; i++) {
			const block = codewords.slice(at, at + len);
			at += len;
			dataBlocks.push(block);
			ecBlocks.push(rsEncode(block, ecCount));
		}
	}
	const out: number[] = [];
	const longest = Math.max(...dataBlocks.map((b) => b.length));
	for (let i = 0; i < longest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
	for (let i = 0; i < ecCount; i++) for (const b of ecBlocks) out.push(b[i]);
	return out;
}

// ------------------------------------------------------------------ format / version information

/** 15-bit format information: BCH(15,5) over `ecBits<<3 | mask`, generator 0x537, XOR mask 0x5412. */
export function formatBits(ec: EcLevel, mask: number): number {
	const data = (EC_BITS[ec] << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (versions ≥ 7): BCH(18,6), generator 0x1F25. */
export function versionBits(version: number): number {
	let rem = version;
	for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
	return (version << 12) | rem;
}

// ------------------------------------------------------------------ matrix

class Matrix {
	readonly size: number;
	readonly modules: Uint8Array;
	readonly reserved: Uint8Array;

	constructor(readonly version: number) {
		this.size = 17 + 4 * version;
		this.modules = new Uint8Array(this.size * this.size);
		this.reserved = new Uint8Array(this.size * this.size);
	}

	get(x: number, y: number): number {
		return this.modules[y * this.size + x];
	}

	/** Set a function module (finder, timing, format …): it is fixed and never masked. */
	fn(x: number, y: number, dark: boolean): void {
		this.modules[y * this.size + x] = dark ? 1 : 0;
		this.reserved[y * this.size + x] = 1;
	}

	drawFunctionPatterns(ec: EcLevel): void {
		const n = this.size;
		// timing patterns
		for (let i = 0; i < n; i++) {
			this.fn(6, i, i % 2 === 0);
			this.fn(i, 6, i % 2 === 0);
		}
		// finders + separators
		this.drawFinder(3, 3);
		this.drawFinder(n - 4, 3);
		this.drawFinder(3, n - 4);
		// alignment patterns (skip the three finder corners)
		const pos = ALIGNMENT[this.version - 1];
		for (let i = 0; i < pos.length; i++) {
			for (let j = 0; j < pos.length; j++) {
				const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
				if (!corner) this.drawAlignment(pos[i], pos[j]);
			}
		}
		this.drawFormat(ec, 0); // reserves the format areas; rewritten once the mask is chosen
		this.drawVersion();
	}

	private drawFinder(cx: number, cy: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.fn(x, y, d !== 2 && d !== 4);
			}
		}
	}

	private drawAlignment(cx: number, cy: number): void {
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.fn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
	}

	drawFormat(ec: EcLevel, mask: number): void {
		const bits = formatBits(ec, mask);
		const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
		const n = this.size;
		// copy 1: around the top-left finder
		for (let i = 0; i <= 5; i++) this.fn(8, i, bit(i));
		this.fn(8, 7, bit(6));
		this.fn(8, 8, bit(7));
		this.fn(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.fn(14 - i, 8, bit(i));
		// copy 2: below the top-right finder and right of the bottom-left finder
		for (let i = 0; i < 8; i++) this.fn(n - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.fn(8, n - 15 + i, bit(i));
		this.fn(8, n - 8, true); // the dark module
	}

	private drawVersion(): void {
		if (this.version < 7) return;
		const bits = versionBits(this.version);
		const n = this.size;
		for (let i = 0; i < 18; i++) {
			const dark = ((bits >>> i) & 1) === 1;
			const a = n - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.fn(a, b, dark);
			this.fn(b, a, dark);
		}
	}

	/** Zigzag placement of the interleaved codewords, two columns at a time, skipping column 6. */
	drawCodewords(data: number[]): void {
		const n = this.size;
		let i = 0;
		for (let right = n - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < n; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? n - 1 - vert : vert;
					if (!this.reserved[y * n + x] && i < data.length * 8) {
						this.modules[y * n + x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
						i++;
					}
				}
			}
		}
	}

	/** XOR the mask pattern into every non-function module (applying twice removes it). */
	applyMask(mask: number): void {
		const n = this.size;
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				if (this.reserved[y * n + x]) continue;
				let invert: boolean;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 === 0;
						break;
					case 1:
						invert = y % 2 === 0;
						break;
					case 2:
						invert = x % 3 === 0;
						break;
					case 3:
						invert = (x + y) % 3 === 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
						break;
					case 5:
						invert = ((x * y) % 2) + ((x * y) % 3) === 0;
						break;
					case 6:
						invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					default:
						invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
				}
				if (invert) this.modules[y * n + x] ^= 1;
			}
		}
	}

	/** ISO 18004 §7.8.3 penalty rules N1–N4; lower is better. */
	penalty(): number {
		const n = this.size;
		let score = 0;
		const line = (get: (i: number) => number): void => {
			let run = 0;
			let last = -1;
			let bits = "";
			for (let i = 0; i < n; i++) {
				const v = get(i);
				bits += v;
				if (v === last) {
					run++;
					if (run === 5) score += 3;
					else if (run > 5) score += 1;
				} else {
					last = v;
					run = 1;
				}
			}
			// finder-like 1:1:3:1:1 with a 4-module light margin on either side
			for (let at = bits.indexOf("10111010000"); at !== -1; at = bits.indexOf("10111010000", at + 1)) score += 40;
			for (let at = bits.indexOf("00001011101"); at !== -1; at = bits.indexOf("00001011101", at + 1)) score += 40;
		};
		for (let y = 0; y < n; y++) line((x) => this.get(x, y));
		for (let x = 0; x < n; x++) line((y) => this.get(x, y));
		for (let y = 0; y + 1 < n; y++) {
			for (let x = 0; x + 1 < n; x++) {
				const c = this.get(x, y);
				if (c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) score += 3;
			}
		}
		let dark = 0;
		for (const m of this.modules) dark += m;
		const total = n * n;
		const k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1;
		return score + Math.max(0, k) * 10;
	}
}

// ------------------------------------------------------------------ public API

/** Encode `text` (UTF-8, byte mode). Throws RangeError when it does not fit version 10 at the chosen level. */
export function encodeQr(text: string, opts: QrOptions = {}): QrMatrix {
	const ec = opts.ec ?? "M";
	const bytes = utf8(text);
	const version = chooseVersion(bytes.length, ec, opts.minVersion ?? 1);
	const m = new Matrix(version);
	m.drawFunctionPatterns(ec);
	m.drawCodewords(interleave(buildCodewords(bytes, version, ec), version, ec));
	let best = 0;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask++) {
		m.applyMask(mask);
		m.drawFormat(ec, mask);
		const score = m.penalty();
		if (score < bestScore) {
			bestScore = score;
			best = mask;
		}
		m.applyMask(mask);
	}
	m.applyMask(best);
	m.drawFormat(ec, best);
	return { version, size: m.size, modules: m.modules, ec, mask: best };
}

/** SVG path data drawing every dark module as a unit square, offset by the quiet zone. */
export function qrPath(m: QrMatrix, quiet = 4): string {
	const parts: string[] = [];
	for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.modules[y * m.size + x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
	return parts.join("");
}

/** A standalone black-on-white `<svg>` (for print windows and tests). */
export function qrToSvg(m: QrMatrix, opts: { moduleSize?: number; quiet?: number } = {}): string {
	const quiet = opts.quiet ?? 4;
	const units = m.size + quiet * 2;
	const px = units * (opts.moduleSize ?? 4);
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${units} ${units}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${units}" height="${units}" fill="#fff"/><path d="${qrPath(m, quiet)}" fill="#000"/></svg>`;
}
