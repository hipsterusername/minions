import type {
  Capability,
  Constraint,
  DecisionMeta,
  Flow,
  Risk,
  ReviewGate,
  SystemModelObject,
  SystemModelPolicies,
} from "../../shared/system-model/index.ts";

export interface ModelValidationError {
  file: string;
  message: string;
  path?: string;
}

export interface LoadedSystemModel {
  root: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  capabilities: Capability[];
  flows: Flow[];
  constraints: Constraint[];
  decisions: DecisionMeta[];
  risks: Risk[];
  policies: SystemModelPolicies;
  objectsById: Map<string, SystemModelObject>;
  reviewGatesById: Map<string, ReviewGate>;
}

export interface SystemModelCounts {
  capabilities: number;
  flows: number;
  constraints: number;
  decisions: number;
  risks: number;
}
