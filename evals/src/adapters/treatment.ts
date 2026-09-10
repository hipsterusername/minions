/** Protocol treatment contract, deliberately independent of application imports. */
const infrastructure = new Set(['executable','stateRoot','appRoot','codexExecutable','isolation','profile','execution','experimentId','imageDigest','networkPolicy']);
export function resolveTreatment(settings:Record<string,unknown>) {
  for (const key of Object.keys(settings)) if (!infrastructure.has(key) && !['model','reasoningEffort'].includes(key)) throw new Error(`unsupported treatment setting: ${key}`);
  if (settings.model !== undefined && (typeof settings.model !== 'string' || !settings.model.trim())) throw new Error('model must be a nonempty string');
  const effort=settings.reasoningEffort;
  if (effort !== undefined && (typeof effort !== 'string' || !['low','medium','high','xhigh','max'].includes(effort))) throw new Error(`unsupported reasoningEffort: ${String(effort)}`);
  return { ...(settings.model === undefined ? {} : {model:settings.model as string}), ...(effort === undefined ? {} : {thinkingConfig:{enabled:true,effort:effort as string,display:'summarized'}}) };
}
