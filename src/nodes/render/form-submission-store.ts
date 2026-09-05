import { applyRenderMessage, findFormById, renderMessageSchema, type RenderState } from "../../../shared/render-dsl.ts";
import type { FormComponent } from "../../../shared/render-form.ts";
import { subscribeSocketTopic, type SocketSubscribeLike } from "../../use-socket.ts";

export interface Decision {
  draft: Record<string, unknown>;
  state: "idle" | "sending" | "unconfirmed" | "stale";
  error: string | null;
  received: Record<string, unknown> | undefined;
  request: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}
export class DecisionStore {
  decisions = new Map<string, Decision>();
  private retired = new WeakMap<FormComponent, Decision>();
  private components = new Map<string, Set<FormComponent>>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private renderState: RenderState = { layout: {}, components: [] };
  private subscribeSocket: SocketSubscribeLike;
  private unsubscribe: (() => void) | undefined;
  send: ((data: unknown) => void) | undefined;
  readonly sessionKey: string | undefined;
  constructor(sessionKey?: string) { this.sessionKey = sessionKey; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;
  changed() { this.revision++; this.listeners.forEach(fn => fn()); }
  get(component: FormComponent, defaults: Record<string, unknown>) {
    const retired = this.retired.get(component);
    if (retired) return retired;
    let instances = this.components.get(component.id);
    if (!instances) { instances = new Set(); this.components.set(component.id, instances); }
    instances.add(component);
    let decision = this.decisions.get(component.id);
    if (!decision) {
      decision = { draft: defaults, state: "idle", error: null, received: undefined, request: null, timer: undefined };
      this.decisions.set(component.id, decision);
      if (!findFormById(this.renderState.components, component.id)) this.renderState.components.push(component);
    }
    return decision;
  }
  receive(decision: Decision, answers: Record<string, unknown>) {
    clearTimeout(decision.timer);
    decision.received = answers;
    decision.request = null;
    decision.error = null;
    this.changed();
  }
  reconcile = () => { this.send?.({ type: "sync_session", sessionKey: this.sessionKey }); };
  connect(send: typeof this.send, subscribe: SocketSubscribeLike) {
    this.send = send;
    if (subscribe === this.subscribeSocket) return;
    this.unsubscribe?.();
    this.subscribeSocket = subscribe;
    this.unsubscribe = subscribeSocketTopic(subscribe, `session:${this.sessionKey}`, this.onMessage);
  }
  private retire(id: string, decision: Decision) {
    clearTimeout(decision.timer);
    decision.state = "stale";
    for (const component of this.components.get(id) ?? []) {
      this.retired.set(component, { ...decision, draft: {}, received: undefined, request: null });
    }
    this.components.delete(id);
    this.decisions.delete(id);
  }
  private onMessage = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    if (msg["type"] === "socket_reconnected") {
      if ([...this.decisions.values()].some(d => d.request && !d.received)) {
        for (const d of this.decisions.values()) if (d.request && !d.received) d.state = "unconfirmed";
        this.changed(); this.reconcile();
      }
      return;
    }
    if ((msg["sessionKey"] ?? msg["leaderSessionKey"]) !== this.sessionKey) return;
    if (msg["type"] === "session_cleared") {
      for (const [id, d] of this.decisions) this.retire(id, d);
      this.renderState = { layout: {}, components: [] };
      this.changed();
      return;
    }
    if (msg["type"] === "control_response" && msg["command"] === "submit_form" && msg["success"] === false) {
      for (const d of this.decisions.values()) {
        if (!d.request || d.request !== msg["requestId"] || d.received) continue;
        clearTimeout(d.timer);
        const stale = msg["code"] === "FORM_ALREADY_SUBMITTED" || msg["code"] === "FORM_NOT_FOUND";
        if (!stale) d.request = null;
        d.state = stale ? "stale" : "idle";
        d.error = typeof msg["error"] === "string" ? msg["error"] : "Response rejected. Your answers are preserved.";
        this.changed();
        if (stale) this.reconcile();
      }
    }
    const isSync = msg["type"] === "sync_response";
    if (!isSync && msg["type"] !== "render_update") return;
    if (isSync && (msg["found"] !== true || !("renderState" in msg))) return;
    const parsed = renderMessageSchema.safeParse(isSync
      ? { action: "set", ...(msg["renderState"] == null ? { components: [] } : msg["renderState"] as object) }
      : msg);
    if (!parsed.success) return;
    this.renderState = applyRenderMessage(this.renderState, parsed.data);
    for (const [id, d] of this.decisions) {
      const form = findFormById(this.renderState.components, id);
      if (!form) this.retire(id, d);
      else if (form.submittedAnswers != null) this.receive(d, form.submittedAnswers);
      else if (isSync && d.request) d.state = "unconfirmed";
    }
    this.changed();
  };
}

// Browser-lifetime intent journal: unmount is not proof of rejection/removal.
// Keep the session subscription alive across tabs to observe late receipts and
// removal (including container removal via the shared reducer). Authoritative
// removal/clear releases drafts, receipts and timers; reuse gets a fresh entry.
// Never age out unresolved intent: that would re-enable duplicate submission.
const sessions = new Map<string, DecisionStore>();
export function sessionDecisions(sessionKey: string) {
  let store = sessions.get(sessionKey);
  if (!store) { store = new DecisionStore(sessionKey); sessions.set(sessionKey, store); }
  return store;
}
