import assert from "node:assert/strict";
import { HttpTts, parseVoices, ttsLang } from "./tts.js";

export async function run(): Promise<void> {
	assert.equal(ttsLang("nb-NO"), "no");
	assert.equal(ttsLang("nn"), "no");
	assert.equal(ttsLang("sv-SE"), "sv");
	assert.equal(parseVoices("no=x, en = y").no, "x");
	assert.equal(parseVoices("no=x, en = y").en, "y");
	assert.ok(parseVoices(undefined).de);

	const calls: string[] = [];
	const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(60)]);
	const fake = (async (_u: unknown, init?: { body?: unknown }) => {
		calls.push(String(init?.body));
		return new Response(new Uint8Array(wav));
	}) as unknown as typeof fetch;
	const log = { debug() {}, info() {}, warn() {} } as never;
	const tts = new HttpTts({ url: "http://x", voices: parseVoices(undefined), log, fetch: fake });
	assert.equal((await tts.speak("Hei", "nb-NO")).length, wav.length);
	await tts.speak("Hei", "no");
	assert.equal(calls.length, 1, "the same sentence is generated once");
	assert.equal(JSON.parse(calls[0]!).voice, "no_NO-talesyntese-medium");
	await assert.rejects(tts.speak("Hola", "es"));
	const bad = new HttpTts({ url: "http://x", voices: parseVoices(undefined), log, fetch: (async () => new Response("nope")) as unknown as typeof fetch });
	await assert.rejects(bad.speak("Hei", "no"));
}
