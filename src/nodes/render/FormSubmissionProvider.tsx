import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { randomUuid } from "../../random-id.ts";
import type { SocketSubscribeLike } from "../../use-socket.ts";
import type { FormComponent } from "../../../shared/render-form.ts";
import { DecisionStore, sessionDecisions } from "./form-submission-store.ts";

interface FormTransport {
  sessionKey: string;
  socketSend: ((data: unknown) => void) | undefined;
  socketSubscribe: SocketSubscribeLike;
  connected?: boolean | undefined;
}
const TransportContext = createContext<FormTransport | null>(null);

/** Transport boundary only; decision lifetime is independent of any view. */
export function FormSubmissionProvider({ children, ...transport }: FormTransport & { children: ReactNode }) {
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}

export function useFormSubmission(component: FormComponent, fallback: (answers: Record<string, unknown>) => void, defaults: Record<string, unknown>) {
  const transport = useContext(TransportContext);
  const [local] = useState(() => new DecisionStore());
  const store = transport ? sessionDecisions(transport.sessionKey) : local;
  useSyncExternalStore(store.subscribe, store.snapshot);
  const decision = store.get(component, defaults);
  const { socketSend, socketSubscribe, connected } = transport ?? {};
  const authoritativeAnswers = component.submittedAnswers ?? decision.received;
  useEffect(() => {
    store.connect(socketSend, socketSubscribe);
    if (decision.request && !decision.received) {
      decision.state = "unconfirmed";
      store.changed();
      if (connected !== false) store.reconcile();
    }
  }, [store, socketSend, socketSubscribe, connected, decision]);
  useEffect(() => {
    if (component.submittedAnswers != null) store.receive(decision, component.submittedAnswers);
  }, [store, decision, component.submittedAnswers]);
  useEffect(() => () => {
    if (!transport) for (const d of local.decisions.values()) clearTimeout(d.timer);
  }, [local, transport === null]);

  function submit(answers: Record<string, unknown>) {
    if (decision.request || authoritativeAnswers != null || decision.state !== "idle") return;
    if (transport && (connected === false || !socketSend || !socketSubscribe)) {
      decision.error = "Not connected. Your answers are preserved. Reconnect before submitting.";
      store.changed();
      return;
    }
    const requestId = randomUuid();
    decision.request = requestId;
    decision.draft = answers;
    decision.error = null;
    decision.state = "sending";
    store.changed();
    decision.timer = setTimeout(() => {
      decision.state = "unconfirmed";
      store.changed(); store.reconcile();
    }, 15_000);
    try {
      if (transport) socketSend?.({ type: "submit_form", sessionKey: transport.sessionKey, formComponentId: component.id, formAnswers: answers, requestId });
      else fallback(answers);
    } catch {
      clearTimeout(decision.timer);
      decision.state = "unconfirmed";
      store.changed(); store.reconcile();
    }
  }
  function setValue(id: string, value: unknown) {
    if (decision.request || decision.received) return;
    decision.draft = { ...decision.draft, [id]: value };
    store.changed();
  }
  return { submit, values: decision.draft, setValue, authoritativeAnswers, error: decision.error, state: decision.state,
    reconcile: store.reconcile, canReconcile: !!transport,
    locked: authoritativeAnswers != null || decision.state !== "idle" };
}
