/** Token-safe text: registered secrets and `Bearer …` are masked. SDK-free (shared by plugin, bridge and hub). */
const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
	if (value && value.trim().length >= 6) secrets.add(value.trim());
}

export function redact(value: unknown): string {
	let text: string;
	if (value instanceof Error) text = `${value.name}: ${value.message}`;
	else if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	for (const s of secrets) text = text.split(s).join("***");
	text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer ***");
	return text;
}
