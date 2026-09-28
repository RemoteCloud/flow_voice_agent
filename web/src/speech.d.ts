/** Injected by vite.config.ts: git sha + build minute of this bundle. */
declare const __WEB_BUILD__: string;

/** Web Speech API types (not in lib.dom for every TS version). */
interface SpeechRecognitionAlternative {
	readonly transcript: string;
	readonly confidence: number;
}
interface SpeechRecognitionResult {
	readonly isFinal: boolean;
	readonly length: number;
	item(index: number): SpeechRecognitionAlternative;
	[index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
	readonly length: number;
	item(index: number): SpeechRecognitionResult;
	[index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
	readonly error: string;
	readonly message: string;
}
interface SpeechRecognition extends EventTarget {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	onresult: ((ev: SpeechRecognitionEvent) => void) | null;
	onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
	onend: (() => void) | null;
	onstart: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
declare var SpeechRecognition: { prototype: SpeechRecognition; new (): SpeechRecognition } | undefined;
interface Window {
	SpeechRecognition?: { prototype: SpeechRecognition; new (): SpeechRecognition };
}
