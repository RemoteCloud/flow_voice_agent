/**
 * Maranics Checklist API v3 + Templates API, called with the signed-in user's token so every write
 * is attributed to them. Routes verified against the Checklist app's integration tests
 * (`V3WriteApiTests`) and the FlowDeck hub:
 *
 *   GET   {flows}/v3/flows?status=Active&page&pageSize
 *   GET   {flows}/v3/flows/{flowId}?include=tasks            → FlowDto with sections[].tasks[] (state, values, controls)
 *   GET   {flows}/v3/flows/{flowId}/tasks?page&pageSize
 *   POST  {flows}/v3/flows                {templateId}         → 201 {flowId}
 *   PUT   {flows}/v3/flows/{flowId}/tasks/values  {items:[{task, value, overrideExistingValue?}]}
 *   PATCH {flows}/v3/flows/{flowId}/tasks/{taskRef}/state {processingState, confirmation}
 *   POST  {flows}/v3/flows/{flowId}/status {action, reasonId?, comment?}
 *   GET   {templates}/templates?ActiveAndDraft=true&page&pageSize   (api-version 1.0)
 *   GET   {templates}/templates/{id}
 *
 * The gateway serves flows at `{host}/app/flows/v3`, the service natively at `{host}/api/v3`.
 */
import { fetchJsonFull, HttpError, normalizeBaseUrl, shortMessage, type FetchLike } from "../core/http.js";

export interface ApiSettings {
	flowsBaseUrl: string;
	templatesBaseUrl: string;
	bearerToken: string;
	tenant: string;
}

export type ClientErrorKind = "unauthorized" | "forbidden" | "notFound" | "conflict" | "rateLimited" | "validation" | "network" | "server" | "invalidConfig";
export type ClientResult<T> = { ok: true; data: T } | { ok: false; kind: ClientErrorKind; status?: number; code?: string; message: string; retryAfterMs?: number };

export interface FlowSummary {
	flowId: string;
	refId?: string;
	name?: string;
	status?: string;
	progress?: { done: number; total: number };
	templateId?: string;
	createdAt?: string;
	completedAt?: string;
	dueTime?: string;
}

export interface TaskControl {
	controlId?: string;
	dataId?: string;
	type: string;
}

export interface TaskValue {
	controlId?: string;
	dataId?: string;
	value?: string;
	time?: string;
	source?: string;
}

export interface TaskDetail {
	taskId: string;
	name?: string;
	status?: string;
	sectionId?: string;
	controls?: TaskControl[];
	state?: { status?: string; processingState?: string; confirmed?: boolean; overridden?: boolean };
	values?: TaskValue[];
	/** Options of a QuickSelect / Dropdown / RadioButtons control when the API exposes them. */
	options?: { title: string; value: string }[];
	order?: number;
}

export interface SectionDetail {
	sectionId: string;
	name?: string;
	status?: string;
	order?: number;
	tasks: TaskDetail[];
}

export interface FlowDetail extends FlowSummary {
	sections: SectionDetail[];
	tasks: TaskDetail[];
}

export interface TemplateInfo {
	id: string;
	name: string;
	refId?: string;
	categoryName?: string;
	status?: string;
}

export interface TemplateTask {
	id: string;
	name: string;
	order: number;
	type?: string;
	dataId?: string;
	options?: { title: string; value: string }[];
	spokenPrompt?: string;
}

/** A discard reason as configured in Flow (per template, or the tenant-wide list). `POST /flows/{id}/status {action:"discard", reason}` matches on `name`. */
export interface DiscardReason {
	name: string;
	requireComment: boolean;
}

export interface TemplateDetail extends TemplateInfo {
	sections: { id: string; name: string; order: number; tasks: TemplateTask[] }[];
	/** The template's own discard reasons; empty → the tenant-wide list applies. */
	discardReasons: DiscardReason[];
}

export interface PageEnvelope<T> {
	total: number;
	page: number;
	pageSize: number;
	items: T[];
}

export function flowsRoot(baseUrl: string): string | undefined {
	const b = normalizeBaseUrl(baseUrl);
	if (!b) return undefined;
	if (/\/v3$/i.test(b)) return b;
	if (/\/app\/flows$/i.test(b)) return `${b}/v3`;
	return `${b}/api/v3`;
}

export function templatesRoots(base: string): string[] | undefined {
	const b = normalizeBaseUrl(base);
	if (!b) return undefined;
	if (/\/api$/i.test(b)) return [b];
	return /\/app\/templates$/i.test(b) ? [b, `${b}/api`] : [`${b}/api`, b];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
/** `Maranics.Checklist.DTO.Enums.TaskType`: the Templates API sends the number, the Checklist API the name. */
const TASK_TYPES = ["Text", "Number", "Dropdown", "Date", "DateAndTime", "Time", "Checkbox", "RadioButtons", "LongText", "PersonsOnBoard", "List", "Picture", "Information", "GPS", "ScanLabel", "RichText", "File", "DataRegister", "SystemLists", "Email", "Sign", "PhoneNumber", "Form", "QuickSelect", "DataList", "AudioRecording", "Drawing"];
export const taskTypeName = (v: unknown): string | undefined => {
	const raw = str(v);
	return raw && /^\d+$/.test(raw) ? TASK_TYPES[Number(raw)] ?? raw : raw;
};
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function query(q: Record<string, string | number | boolean | undefined>): string {
	const qs = Object.entries(q)
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
		.join("&");
	return qs ? `?${qs}` : "";
}

export function mapHttpError(err: unknown): ClientResult<never> {
	if (err instanceof HttpError) {
		const status = err.status;
		const kind: ClientErrorKind =
			status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "notFound" : status === 409 ? "conflict" : status === 429 ? "rateLimited" : status === 400 || status === 422 ? "validation" : status >= 500 ? "server" : "network";
		let message = `HTTP ${status}`;
		let code: string | undefined;
		try {
			const pd = err.bodyText ? (JSON.parse(err.bodyText) as { code?: string; title?: string; detail?: string }) : undefined;
			if (pd?.code) {
				code = pd.code;
				message += ` ${pd.code}`;
			} else if (pd?.title) message += ` ${pd.title}`;
			if (pd?.detail) message += `: ${pd.detail.slice(0, 160)}`;
		} catch {
			/* not problem-details */
		}
		return { ok: false, kind, status, code, message, retryAfterMs: err.retryAfterMs };
	}
	return { ok: false, kind: "network", message: shortMessage(err) };
}

/** Parse `Values` of a QuickSelect/Dropdown control: JSON array of `{title,value}` or newline / `;` separated text. */
export function parseOptions(raw: unknown): { title: string; value: string }[] | undefined {
	if (Array.isArray(raw)) {
		const out = raw
			.map((x) => (isObj(x) ? { title: str(x.title) ?? str(x.value) ?? "", value: str(x.value) ?? str(x.title) ?? "" } : typeof x === "string" ? { title: x, value: x } : undefined))
			.filter((x): x is { title: string; value: string } => !!x && !!x.value);
		return out.length ? out : undefined;
	}
	if (typeof raw === "string" && raw.trim()) {
		const t = raw.trim();
		if (t.startsWith("[")) {
			try {
				return parseOptions(JSON.parse(t));
			} catch {
				/* fall through */
			}
		}
		const parts = t
			.split(/\r?\n|;/)
			.map((x) => x.trim())
			.filter(Boolean);
		// Flow's list controls store "Title::key" per line and validate the key (DataValidation.IsListValid:
		// the part after "::" when present, else the whole line), so the key is the value we write back.
		return parts.length
			? parts.map((p) => {
					const arr = p.split("::");
					const key = arr.length > 1 && arr[1].trim() ? arr[1].trim() : arr[0].trim();
					return { title: arr[0].trim() || key, value: key };
				})
			: undefined;
	}
	return undefined;
}

function toTask(raw: unknown, i: number): TaskDetail | undefined {
	if (!isObj(raw)) return undefined;
	const taskId = str(raw.taskId) ?? str(raw.id);
	if (!taskId) return undefined;
	const controlsRaw = Array.isArray(raw.controls) ? raw.controls : isObj(raw.control) ? [raw.control] : [];
	const controls = controlsRaw
		.map((c): TaskControl | undefined => (isObj(c) ? { controlId: str(c.controlId) ?? str(c.id), dataId: str(c.dataId), type: taskTypeName(c.type) ?? "Text" } : undefined))
		.filter((c): c is TaskControl => !!c);
	const valuesRaw = Array.isArray(raw.values) ? raw.values : [];
	const values = valuesRaw.map((v): TaskValue | undefined => (isObj(v) ? { controlId: str(v.controlId), dataId: str(v.dataId), value: str(v.value), time: str(v.time), source: str(v.source) } : undefined)).filter((v): v is TaskValue => !!v);
	let options: TaskDetail["options"];
	for (const c of controlsRaw) {
		if (!isObj(c)) continue;
		options = parseOptions(c.quickSelectValues) ?? parseOptions(c.values) ?? parseOptions(c.options) ?? options;
	}
	options = options ?? parseOptions(raw.options) ?? parseOptions(raw.quickSelectValues);
	const state = isObj(raw.state) ? { status: str(raw.state.status), processingState: str(raw.state.processingState), confirmed: raw.state.confirmed === true, overridden: raw.state.overridden === true } : undefined;
	return { taskId, name: str(raw.name), status: str(raw.status) ?? state?.status, sectionId: str(raw.sectionId), controls, state, values, options, order: num(raw.order, i) };
}

export function toFlowDetail(raw: unknown): FlowDetail | undefined {
	if (!isObj(raw)) return undefined;
	const flowId = str(raw.flowId) ?? str(raw.id);
	if (!flowId) return undefined;
	const summary = toSummary(raw) as FlowSummary;
	const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : [];
	const sections: SectionDetail[] = sectionsRaw
		.map((s, i): SectionDetail | undefined => {
			if (!isObj(s)) return undefined;
			const sectionId = str(s.sectionId) ?? str(s.id);
			if (!sectionId) return undefined;
			const tasks = (Array.isArray(s.tasks) ? s.tasks : []).map(toTask).filter((t): t is TaskDetail => !!t);
			for (const t of tasks) t.sectionId = t.sectionId ?? sectionId;
			return { sectionId, name: str(s.name), status: str(s.status), order: num(s.order, i), tasks };
		})
		.filter((s): s is SectionDetail => !!s);
	let tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map(toTask).filter((t): t is TaskDetail => !!t);
	if (!tasks.length) tasks = sections.flatMap((s) => s.tasks);
	// sections without embedded tasks: attach by sectionId, keep API order
	if (sections.length && sections.every((s) => s.tasks.length === 0)) for (const s of sections) s.tasks = tasks.filter((t) => t.sectionId === s.sectionId);
	return { ...summary, flowId, sections, tasks };
}

export function toSummary(raw: unknown): FlowSummary | undefined {
	if (!isObj(raw)) return undefined;
	const flowId = str(raw.flowId) ?? str(raw.id);
	if (!flowId) return undefined;
	const p = isObj(raw.progress) ? { done: num(raw.progress.done, 0), total: num(raw.progress.total, 0) } : undefined;
	return { flowId, refId: str(raw.refId), name: str(raw.name), status: str(raw.status), progress: p, templateId: str(raw.templateId), createdAt: str(raw.createdAt), completedAt: str(raw.completedAt), dueTime: str(raw.dueTime) };
}

function toTemplateInfo(raw: unknown): TemplateInfo | undefined {
	if (!isObj(raw)) return undefined;
	const id = str(raw.id);
	if (!id) return undefined;
	return { id, name: str(raw.name) ?? id, refId: str(raw.refId), categoryName: str(raw.categoryName), status: str(raw.status) };
}

export function toTemplateDetail(raw: unknown): TemplateDetail | undefined {
	const info = toTemplateInfo(raw);
	if (!info || !isObj(raw)) return undefined;
	const sectionsRaw = Array.isArray(raw.sectionTemplates) ? raw.sectionTemplates : Array.isArray(raw.sections) ? raw.sections : [];
	const sections = sectionsRaw
		.map((s, i) => {
			if (!isObj(s)) return undefined;
			const id = str(s.id);
			if (!id) return undefined;
			const tasksRaw = Array.isArray(s.taskTemplates) ? s.taskTemplates : Array.isArray(s.tasks) ? s.tasks : [];
			const tasks = tasksRaw
				.map((t, j): TemplateTask | undefined => {
					if (!isObj(t)) return undefined;
					const tid = str(t.id);
					if (!tid) return undefined;
					const control = isObj(t.control) ? t.control : isObj(t.taskTemplateControl) ? t.taskTemplateControl : undefined;
					const type = taskTypeName(control?.type) ?? taskTypeName(t.type) ?? taskTypeName(t.controlType);
					return { id: tid, name: str(t.name) ?? tid, order: num(t.order, j), type, dataId: str(control?.dataId) ?? str(t.dataId), options: parseOptions(control?.quickSelectValues) ?? parseOptions(control?.values), spokenPrompt: str(t.spokenPrompt) };
				})
				.filter((t): t is TemplateTask => !!t)
				.sort((a, b) => a.order - b.order);
			return { id, name: str(s.name) ?? id, order: num(s.order, i), tasks };
		})
		.filter((s): s is TemplateDetail["sections"][number] => !!s)
		.sort((a, b) => a.order - b.order);
	return { ...info, sections, discardReasons: parseDiscardReasons(raw.discardReasons) };
}

export function parseDiscardReasons(raw: unknown): DiscardReason[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((x): DiscardReason | undefined => {
			if (!isObj(x)) return undefined;
			const name = str(x.name) ?? str(x.title);
			return name ? { name, requireComment: x.requireComment === true } : undefined;
		})
		.filter((x): x is DiscardReason => !!x);
}

function envelope<T>(body: unknown, mapItem: (x: unknown, i: number) => T | undefined, page: number, pageSize: number): PageEnvelope<T> {
	const o = (body ?? {}) as Partial<PageEnvelope<unknown>>;
	const rows = Array.isArray(o.items) ? o.items : Array.isArray(body) ? (body as unknown[]) : [];
	const items = rows.map((x, i) => mapItem(x, i)).filter((x): x is T => x !== undefined);
	return { total: typeof o.total === "number" ? o.total : items.length, page: typeof o.page === "number" ? o.page : page, pageSize: typeof o.pageSize === "number" ? o.pageSize : pageSize, items };
}

export interface FlowsClientOptions {
	fetchImpl?: FetchLike;
	timeoutMs?: number;
}

export class FlowsClient {
	private readonly resolvedTemplatesRoots = new Map<string, string>();
	constructor(private readonly opts: FlowsClientOptions = {}) {}

	private headers(s: ApiSettings, extra: Record<string, string> = {}): Record<string, string> {
		return { Authorization: `Bearer ${s.bearerToken.trim()}`, Tenant: s.tenant.trim(), Accept: "application/json", ...extra };
	}

	private async call<T>(url: string, init: RequestInit, map: (body: unknown, headers: Headers) => T): Promise<ClientResult<T>> {
		try {
			const res = await fetchJsonFull<unknown>(url, init, { fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.timeoutMs ?? 10000 });
			return { ok: true, data: map(res.body, res.headers) };
		} catch (err) {
			return mapHttpError(err);
		}
	}

	// ----- flows -----
	listFlows(s: ApiSettings, status = "Active", page = 1, pageSize = 100): Promise<ClientResult<PageEnvelope<FlowSummary>>> {
		const root = flowsRoot(s.flowsBaseUrl);
		if (!root) return Promise.resolve({ ok: false, kind: "invalidConfig", message: "invalid flows base URL" });
		return this.call(`${root}/flows${query({ status, page, pageSize: Math.min(500, pageSize) })}`, { headers: this.headers(s) }, (b) => envelope(b, toSummary, page, pageSize));
	}

	async getFlow(s: ApiSettings, flowId: string): Promise<ClientResult<FlowDetail>> {
		const root = flowsRoot(s.flowsBaseUrl);
		if (!root) return { ok: false, kind: "invalidConfig", message: "invalid flows base URL" };
		const r = await this.call(`${root}/flows/${encodeURIComponent(flowId)}${query({ include: "tasks" })}`, { headers: this.headers(s) }, (b) => toFlowDetail(b));
		if (!r.ok) return r;
		if (!r.data) return { ok: false, kind: "server", message: "unexpected flow payload" };
		if (!r.data.tasks.length) {
			// older builds ignore include=tasks; page the task list
			const tasks = await this.listTasks(s, flowId);
			if (tasks.ok) {
				r.data.tasks = tasks.data;
				for (const sec of r.data.sections) sec.tasks = tasks.data.filter((t) => t.sectionId === sec.sectionId);
			}
		}
		return { ok: true, data: r.data };
	}

	async listTasks(s: ApiSettings, flowId: string): Promise<ClientResult<TaskDetail[]>> {
		const root = flowsRoot(s.flowsBaseUrl);
		if (!root) return { ok: false, kind: "invalidConfig", message: "invalid flows base URL" };
		const out: TaskDetail[] = [];
		for (let page = 1; page <= 20; page++) {
			const r = await this.call(`${root}/flows/${encodeURIComponent(flowId)}/tasks${query({ page, pageSize: 200 })}`, { headers: this.headers(s) }, (b) => envelope(b, toTask, page, 200));
			if (!r.ok) return r;
			out.push(...r.data.items);
			if (r.data.items.length < 200 || out.length >= r.data.total) break;
		}
		return { ok: true, data: out };
	}

	createFlow(s: ApiSettings, templateId: string, name?: string): Promise<ClientResult<{ flowId: string }>> {
		const root = flowsRoot(s.flowsBaseUrl);
		if (!root) return Promise.resolve({ ok: false, kind: "invalidConfig", message: "invalid flows base URL" });
		const body: Record<string, unknown> = { templateId };
		if (name) body.name = name;
		return this.call(`${root}/flows`, { method: "POST", headers: this.headers(s, { "Content-Type": "application/json" }), body: JSON.stringify(body) }, (b) => {
			const id = isObj(b) ? (str(b.flowId) ?? str(b.id)) : undefined;
			if (!id) throw new Error("create flow: no flowId in response");
			return { flowId: id };
		});
	}

	/**
	 * Write one value. `task` is the task id or a DataId (the API resolves both: `taskRef`).
	 * Response is the bulk envelope; the first item's `status`/`code` tells whether it stuck.
	 */
	putValue(s: ApiSettings, flowId: string, taskRef: string, value: string, opts: { overrideExistingValue?: boolean; idempotencyKey?: string } = {}): Promise<ClientResult<{ ok: boolean; code?: string; message?: string; raw: unknown }>> {
		const root = flowsRoot(s.flowsBaseUrl);
		if (!root) return Promise.resolve({ ok: false, kind: "invalidConfig", message: "invalid flows base URL" });
		const item: Record<string, unknown> = { task: taskRef, value };
		if (opts.overrideExistingValue) item.overrideExistingValue = true;
		const headers = this.headers(s, { "Content-Type": "application/json", ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}) });
		return this.call(`${root}/flows/${encodeURIComponent(flowId)}/tasks/values`, { method: "PUT", headers, body: JSON.stringify({ items: [item] }) }, (b) => {
			const items = isObj(b) && Array.isArray(b.items) ? b.items : Array.isArray(b) ? b : [];
			const first = items.find(isObj);
			if (!first) return { ok: true, raw: b };
			const status = num(first.status, 200);
			const code = str(first.code) ?? (isObj(first.error) ? str(first.error.code) : undefined);
			const ok = status >= 200 && status < 300 && !code;
			const err = isObj(first.error) ? first.error : undefined;
			// the real reason lives in error.detail ("The submitted value was rejected: …"); title is just the status text
			const message = str(first.message) ?? str(first.detail) ?? (err ? (str(err.detail) ?? str(err.title)) : undefined) ?? str(first.title);
			return { ok, code, message, raw: b };
		});
	}

	patchTaskState(s: ApiSettings, flowId: string, taskRef: string, body: { processingState: "Pending" | "InProgress" | "Finished" | "Failed"; confirmation?: { source?: string; time?: string } }): Promise<ClientResult<{ status?: string; processingState?: string }>> {
		const root = flowsRoot(s.flowsBaseUrl);
		if (!root) return Promise.resolve({ ok: false, kind: "invalidConfig", message: "invalid flows base URL" });
		return this.call(`${root}/flows/${encodeURIComponent(flowId)}/tasks/${encodeURIComponent(taskRef)}/state`, { method: "PATCH", headers: this.headers(s, { "Content-Type": "application/json" }), body: JSON.stringify(body) }, (b) => {
			const o = isObj(b) ? (isObj(b.state) ? b.state : b) : {};
			return { status: str(o.status), processingState: str(o.processingState) };
		});
	}

	/** `action`: complete | discard | reopen (names as accepted by the Flow app; a 422 lists the valid ones in `detail`). */
	setStatus(s: ApiSettings, flowId: string, action: string, extra: Record<string, unknown> = {}): Promise<ClientResult<{ status?: string }>> {
		const root = flowsRoot(s.flowsBaseUrl);
		if (!root) return Promise.resolve({ ok: false, kind: "invalidConfig", message: "invalid flows base URL" });
		return this.call(`${root}/flows/${encodeURIComponent(flowId)}/status`, { method: "POST", headers: this.headers(s, { "Content-Type": "application/json" }), body: JSON.stringify({ action, ...extra }) }, (b) => ({ status: isObj(b) ? str(b.status) : undefined }));
	}

	// ----- templates -----
	private async templatesRequest<T>(s: ApiSettings, pathAndQuery: string, map: (b: unknown, h: Headers) => T): Promise<ClientResult<T>> {
		const bare = normalizeBaseUrl(s.templatesBaseUrl);
		const candidates = templatesRoots(s.templatesBaseUrl);
		if (!bare || !candidates) return { ok: false, kind: "invalidConfig", message: "invalid templates base URL" };
		const remembered = this.resolvedTemplatesRoots.get(bare);
		const order = remembered ? [remembered] : candidates;
		let last: ClientResult<T> = { ok: false, kind: "network", message: "no candidate" };
		for (let i = 0; i < order.length; i++) {
			const r = await this.call(`${order[i]}${pathAndQuery}`, { headers: this.headers(s, { "api-version": "1.0" }) }, map);
			if (r.ok) {
				if (i > 0) this.resolvedTemplatesRoots.set(bare, order[i]);
				return r;
			}
			last = r;
			if (!(r.kind === "notFound" && i === 0 && order.length > 1)) return r;
		}
		return last;
	}

	listTemplates(s: ApiSettings, search?: string, page = 1, pageSize = 200): Promise<ClientResult<{ items: TemplateInfo[]; total: number }>> {
		// the Templates API wants at least one status group (ActiveAndDraft / Deactivated / Archived), else 400 "You need to define at least one status"
		const q = query({ ActiveAndDraft: true, page, pageSize, SearchString: search, SearchInTitle: search ? true : undefined });
		return this.templatesRequest(s, `/templates${q}`, (b, h) => {
			const rows = Array.isArray(b) ? b : isObj(b) && Array.isArray(b.items) ? b.items : isObj(b) && Array.isArray(b.data) ? b.data : [];
			const items = rows.map(toTemplateInfo).filter((t): t is TemplateInfo => !!t);
			const th = h.get("x-total-count");
			return { items, total: th && /^\d+$/.test(th) ? Number(th) : items.length };
		});
	}

	getTemplate(s: ApiSettings, id: string): Promise<ClientResult<TemplateDetail>> {
		return this.templatesRequest(s, `/templates/${encodeURIComponent(id)}${query({ excludeDocumentation: true, excludeWebhooks: true, excludePermissions: true })}`, (b) => {
			const d = toTemplateDetail(b);
			if (!d) throw new Error("unexpected template payload");
			return d;
		});
	}

	/** Tenant-wide discard reasons (`GET /discardReasons` on the Templates API); used when a template has none of its own. */
	getDiscardReasons(s: ApiSettings): Promise<ClientResult<DiscardReason[]>> {
		return this.templatesRequest(s, "/discardReasons", (b) => parseDiscardReasons(isObj(b) && Array.isArray(b.items) ? b.items : b));
	}
}
