import assert from "node:assert/strict";
import { HttpTts, parseVoices, ttsLang } from "./tts.js";

export async function run(): Promise<void> {
	assert.equal(ttsLang("nb-NO"), "no");
	assert.equal(ttsLang("nn"), "no");
	assert.equal(ttsLang("sv-SE"), "sv");
	assert.deepEqual(parseVoices("no=x, en = y").no, ["x"]);
	assert.deepEqual(parseVoices("no=x, en = y").en, ["y"]);
	assert.deepEqual(parseVoices("nb=a|b|a").no, ["a", "b"], "several voices per language, nb = no");
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
	const two = new HttpTts({ url: "http://x", voices: parseVoices("no=a|b"), log, fetch: fake });
	assert.equal(two.voiceFor("no", "b"), "b", "a picked voice the server has");
	assert.equal(two.voiceFor("no", "zz"), "a", "an unknown voice falls back to the language's default");
	assert.equal(two.voiceFor("no"), "a");
	await two.speak("Hei igjen", "no", "b");
	assert.equal(JSON.parse(calls[calls.length - 1]!).voice, "b");
	assert.deepEqual(two.voices().no, ["a", "b"]);
	const bad = new HttpTts({ url: "http://x", voices: parseVoices(undefined), log, fetch: (async () => new Response("nope")) as unknown as typeof fetch });
	await assert.rejects(bad.speak("Hei", "no"));
}
