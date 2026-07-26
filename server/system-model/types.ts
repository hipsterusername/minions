import type {
  Capability,
  Domain,
  Constraint,
  DecisionMeta,
  Flow,
  Risk,
  Surface,
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
  domains: Domain[];
  capabilities: Capability[];
  flows: Flow[];
  constraints: Constraint[];
  decisions: DecisionMeta[];
  risks: Risk[];
  surfaces: Surface[];
  policies: SystemModelPolicies;
  objectsById: Map<string, SystemModelObject>;
  reviewGatesById: Map<string, ReviewGate>;
}

export interface SystemModelCounts {
  domains: number;
  capabilities: number;
  flows: number;
  constraints: number;
  decisions: number;
  risks: number;
  surfaces: number;
}
