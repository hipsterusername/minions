---
id: decision.role_gated_agent_tools
type: decision
title: Register agent tools by role and armed capability
status: accepted
summary: Leaders, minions, and transient actors receive only tools valid for their role, harness, worktree mode, and armed skills.
evidence: [server/agents/leader.ts, server/agents/minion.ts, server/task-tools.ts, server/minion-tools.ts]
---
# Register agent tools by role and armed capability

Tool factories define behavior while role allowlists and conditional registration determine callability. Minion reporting, Leader orchestration, approval, system-model, rendering, and skill-authoring tools are exposed only when their prerequisites hold.

Factory output and allowlists must remain equal after conditional filtering so documented capabilities are neither silently absent nor accidentally overexposed.
