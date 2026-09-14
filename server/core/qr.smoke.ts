import assert from "node:assert/strict";
import { byteCapacity, chooseVersion, encodeQr, formatBits, qrPath, qrToSvg, rsEncode, versionBits, type QrMatrix } from "./qr.js";

const at = (m: QrMatrix, x: number, y: number): number => m.modules[y * m.size + x];

/** Read the 15 format bits back from copy 1 (around the top-left finder) and undo the 0x5412 mask. */
function readFormat(m: QrMatrix): { ec: number; mask: number } {
	const bits: number[] = new Array<number>(15).fill(0);
	for (let i = 0; i <= 5; i++) bits[i] = at(m, 8, i);
	bits[6] = at(m, 8, 7);
	bits[7] = at(m, 8, 8);
	bits[8] = at(m, 7, 8);
	for (let i = 9; i < 15; i++) bits[i] = at(m, 14 - i, 8);
	let word = 0;
	for (let i = 14; i >= 0; i--) word = (word << 1) | bits[i];
	word ^= 0x5412;
	// BCH(15,5) check: the remainder of the whole word by 0x537 must be zero
	let rem = word;
	for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
	assert.equal(rem, 0, "format information fails its BCH check");
	const data = word >>> 10;
	return { ec: data >>> 3, mask: data & 7 };
}

/** Same for copy 2 (below the top-right finder / right of the bottom-left finder). */
function readFormat2(m: QrMatrix): { ec: number; mask: number } {
	const n = m.size;
	const bits: number[] = new Array<number>(15).fill(0);
	for (let i = 0; i < 8; i++) bits[i] = at(m, n - 1 - i, 8);
	for (let i = 8; i < 15; i++) bits[i] = at(m, 8, n - 15 + i);
	let word = 0;
	for (let i = 14; i >= 0; i--) word = (word << 1) | bits[i];
	word ^= 0x5412;
	const data = word >>> 10;
	return { ec: data >>> 3, mask: data & 7 };
}

function assertFinder(m: QrMatrix, x0: number, y0: number): void {
	for (let dy = 0; dy < 7; dy++) {
		for (let dx = 0; dx < 7; dx++) {
			const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
			const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
			assert.equal(at(m, x0 + dx, y0 + dy), edge || core ? 1 : 0, `finder at (${x0},${y0}) module (${dx},${dy})`);
		}
	}
}

export async function run(): Promise<void> {
	// Reed–Solomon: the published 1-M "HELLO WORLD" vector (16 data codewords → 10 EC codewords).
	assert.deepEqual(rsEncode([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);

	// version selection at level M (byte capacities from ISO 18004 table 7)
	assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => byteCapacity(v, "M")), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
	assert.equal(chooseVersion(14), 1);
	assert.equal(chooseVersion(15), 2);
	assert.equal(chooseVersion(106), 6);
	assert.equal(chooseVersion(107), 7);
	assert.equal(chooseVersion(213), 10);
	assert.throws(() => chooseVersion(214), RangeError);
	assert.throws(() => encodeQr("x".repeat(214)), RangeError);
	assert.equal(byteCapacity(1, "L"), 17);
	assert.equal(byteCapacity(1, "H"), 7);
	assert.equal(chooseVersion(20, "M", 5), 5, "minVersion is honoured");

	// format / version information
	assert.equal(formatBits("M", 0), 0x5412, "M + mask 0 has a zero BCH remainder, so the word is the XOR mask");
	assert.equal(formatBits("L", 0), 0x77c4);
	assert.equal(formatBits("H", 7), 0x083b);
	assert.equal(versionBits(7), 0x07c94);
	assert.equal(versionBits(10), 0x0a4d3);

	// structure of a version 1 symbol
	const hello = encodeQr("HELLO");
	assert.equal(hello.version, 1);
	assert.equal(hello.size, 21);
	assert.equal(hello.ec, "M");
	assertFinder(hello, 0, 0);
	assertFinder(hello, 14, 0);
	assertFinder(hello, 0, 14);
	for (let i = 8; i <= 12; i++) {
		assert.equal(at(hello, i, 6), i % 2 === 0 ? 1 : 0, `timing row at ${i}`);
		assert.equal(at(hello, 6, i), i % 2 === 0 ? 1 : 0, `timing column at ${i}`);
	}
	assert.equal(at(hello, 8, 13), 1, "dark module at (8, 4v+9)");
	for (let i = 0; i < 7; i++) {
		assert.equal(at(hello, 7, i), 0, "separator right of the top-left finder");
		assert.equal(at(hello, i, 7), 0, "separator below the top-left finder");
	}
	const f1 = readFormat(hello);
	const f2 = readFormat2(hello);
	assert.deepEqual(f1, { ec: 0, mask: hello.mask });
	assert.deepEqual(f2, f1, "both format copies agree");

	// every level and every version encodes, decodes its format word, and is deterministic
	for (const ec of ["L", "M", "Q", "H"] as const) {
		for (let v = 1; v <= 10; v++) {
			const text = "a".repeat(byteCapacity(v, ec));
			const m = encodeQr(text, { ec });
			assert.equal(m.version, v, `${ec} v${v} fills exactly`);
			assert.equal(m.size, 17 + 4 * v);
			assert.deepEqual(readFormat(m), { ec: { L: 1, M: 0, Q: 3, H: 2 }[ec], mask: m.mask }, `${ec} v${v} format`);
			assert.deepEqual(readFormat2(m), readFormat(m));
			const again = encodeQr(text, { ec });
			assert.deepEqual(Array.from(again.modules), Array.from(m.modules), `${ec} v${v} deterministic`);
			if (v >= 7) {
				// version information sits in the 6×3 block left of the top-right finder
				const bits = versionBits(v);
				for (let i = 0; i < 18; i++) assert.equal(at(m, m.size - 11 + (i % 3), Math.floor(i / 3)), (bits >>> i) & 1, `v${v} version info bit ${i}`);
			}
		}
	}

	// alignment pattern of version 2 centred on (18, 18)
	const v2 = encodeQr("x".repeat(20));
	assert.equal(v2.version, 2);
	assert.equal(at(v2, 18, 18), 1);
	assert.equal(at(v2, 17, 18), 0);
	assert.equal(at(v2, 16, 18), 1);

	// a station join URL lands on version 6–7 at M and renders to SVG
	const url = "http://192.168.10.20:8443/?mobile=1#/join/fvj_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghi";
	const join = encodeQr(url);
	assert.ok(join.version === 6 || join.version === 7, `join URL version ${join.version}`);
	const svg = qrToSvg(join, { moduleSize: 8 });
	assert.ok(svg.startsWith("<svg"));
	assert.ok(svg.includes("<path d=\"M"));
	assert.ok(qrPath(join).split("h1v1h-1z").length - 1 > 400, "a version 6+ symbol has hundreds of dark modules");

	// UTF-8: a multibyte string counts bytes, not characters
	assert.equal(encodeQr("é".repeat(7)).version, 1);
	assert.equal(encodeQr("é".repeat(8)).version, 2);
}
