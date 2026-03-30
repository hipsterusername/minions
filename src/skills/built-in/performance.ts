import type { SkillTemplate } from "../types.ts";

export const performanceSkill: SkillTemplate = {
  id: "performance",
  name: "Performance",
  description: "Analyze and optimize code for speed, memory, and efficiency.",
  category: "analysis",
  icon: "⚡",
  accentColor: "#fbbf24",
  template: `# Performance Analysis

You are performing a focused performance audit.

## Target
{{target}}

## Focus: {{focus}}
## Environment: {{environment}}

## Instructions
- Profile and identify performance bottlenecks in the target code
- Check for N+1 queries, unnecessary re-renders, and memory leaks
- Analyze algorithmic complexity (Big-O) and suggest improvements where possible
- Look for unnecessary allocations, copies, and computations
- Check bundle size impact and tree-shaking opportunities
- Suggest caching strategies where appropriate (memoization, HTTP cache, data cache)
- Implement fixes directly — do not just list recommendations

## Focus-Specific Guidance
{{#focus:rendering}}Pay special attention to component re-renders, virtual DOM diffing, layout thrashing, and paint performance.{{/focus:rendering}}
{{#focus:network}}Pay special attention to request waterfalls, payload sizes, connection reuse, and data fetching patterns.{{/focus:network}}
{{#focus:memory}}Pay special attention to memory leaks, retained references, large object graphs, and garbage collection pressure.{{/focus:memory}}
{{#focus:bundle-size}}Pay special attention to tree-shaking, code splitting, dependency weight, and dead code elimination.{{/focus:bundle-size}}
{{#focus:general}}Perform a broad analysis across all performance dimensions.{{/focus:general}}

## Additional Notes
{{notes}}`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Code, files, or system to analyze for performance",
      required: true,
    },
    {
      name: "focus",
      label: "Focus",
      type: "select",
      defaultValue: "general",
      options: [
        { value: "general", label: "General" },
        { value: "rendering", label: "Rendering" },
        { value: "network", label: "Network" },
        { value: "memory", label: "Memory" },
        { value: "bundle-size", label: "Bundle Size" },
      ],
    },
    {
      name: "environment",
      label: "Environment",
      type: "select",
      defaultValue: "both",
      options: [
        { value: "browser", label: "Browser" },
        { value: "node", label: "Node.js" },
        { value: "both", label: "Both" },
      ],
    },
    {
      name: "notes",
      label: "Additional Notes",
      type: "textarea",
      placeholder: "Known issues or constraints (optional)",
    },
  ],
};
