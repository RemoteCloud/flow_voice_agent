import assert from "node:assert/strict";
import { captureKey, captureRecord, objectUrl, s3Encode, signS3, slug } from "./capture.js";

export async function run(): Promise<void> {
	// AWS SigV4 documentation example: GET Object with a Range header (examplebucket, 2013-05-24)
	const h = signS3({
		method: "GET",
		url: "https://examplebucket.s3.amazonaws.com/test.txt",
		region: "us-east-1",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		headers: { Range: "bytes=0-9" },
		now: new Date("2013-05-24T00:00:00Z"),
	});
	assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
	assert.equal(h["x-amz-date"], "20130524T000000Z");
	assert.equal(h.host, undefined);

	assert.equal(s3Encode("a b/c(d)"), "a%20b%2Fc%28d%29");
	assert.equal(s3Encode("a b/c", true), "a%20b/c");
	assert.equal(objectUrl({ endpoint: "http://minio:9000", bucket: "voice", pathStyle: true }, "fv/x y.wav"), "http://minio:9000/voice/fv/x%20y.wav");
	assert.equal(objectUrl({ endpoint: "https://s3.eu-north-1.amazonaws.com", bucket: "voice", pathStyle: false }, "fv/a.wav"), "https://voice.s3.eu-north-1.amazonaws.com/fv/a.wav");

	assert.equal(slug("NauticAI/ArrivalChecklist"), "nauticai-arrivalchecklist");
	assert.equal(slug("Körbro hivt"), "korbro-hivt");
	assert.equal(slug(""), "unknown");

	const rec = captureRecord({
		clipId: "c1",
		recordedAt: new Date("2026-09-24T10:00:00Z"),
		pcmBytes: 32000 * 2,
		source: { hub: "vessel", core: "main", tenant: "demo" },
		ctx: { runId: "run_1", instanceId: "flow-arr-1", templateId: "NauticAI/ArrivalChecklist", templateName: "Arrival", language: "no", stationId: "bridge", exchange: "listening", prompt: "Car deck ramp?", item: { taskId: "t1", dataId: "RAMP", name: "Car deck ramp", index: 1, type: "Checkbox", answerWords: ["hivt + körbro"] }, before: [] },
		outcome: { changed: [{ taskId: "t1", dataId: "RAMP", name: "Car deck ramp", state: "answered", value: "true", valueText: "hivt körbro" }], exchange: "speaking", runState: "active" },
		recognition: { text: "körbro er hivt", confidence: 0.8, by: "endpoint", language: "no" },
		windowId: "p_1",
		speaker: "abcd",
	});
	assert.equal(rec.schema, "flow-voice.capture/1");
	assert.equal(rec.audio.durationMs, 2000);
	assert.equal(rec.item?.dataId, "RAMP");
	assert.equal(rec.outcome.changed[0].valueText, "hivt körbro");
	assert.equal(captureKey("/flow-voice/", rec), "flow-voice/main/nauticai-arrivalchecklist/2026-09-24/c1");
}
