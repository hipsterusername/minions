import type { SkillTemplate } from "../types.ts";

export const apiDesignSkill: SkillTemplate = {
  id: "api-design",
  name: "API Design",
  description:
    "Design clean, consistent APIs with proper error handling and documentation.",
  category: "design",
  icon: "🔌",
  accentColor: "#2dd4bf",
  template: `# API Design

You are designing or implementing an API.

## Target
{{target}}

## API Style: {{style}}

## Authentication: {{auth_method}}

## Output Mode: {{output}}

## Instructions
- Follow RESTful conventions or the specified API style ({{style}})
- Design consistent naming and URL patterns across all endpoints
- Define clear request/response schemas with TypeScript types
- Plan proper error handling with meaningful HTTP status codes and error response bodies
- Consider a versioning strategy (URL prefix, header, or query param)
- Design for backwards compatibility — additive changes only, deprecation before removal
- Include rate limiting and pagination where appropriate for list endpoints
- Generate API documentation with endpoint summaries, request/response examples, and error cases

{{#style:rest}}
### RESTful Guidelines
- Use plural nouns for resource collections (e.g. /users, /posts)
- Use proper HTTP methods: GET (read), POST (create), PUT (replace), PATCH (update), DELETE (remove)
- Return appropriate status codes: 200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500
- Support filtering, sorting, and pagination via query parameters
{{/style:rest}}

{{#style:graphql}}
### GraphQL Guidelines
- Define clear Query and Mutation types
- Use input types for complex arguments
- Design connection-based pagination (Relay-style cursors)
- Plan error handling via errors array and extensions
{{/style:graphql}}

{{#style:trpc}}
### tRPC Guidelines
- Define procedures with proper input validation (Zod schemas)
- Organize routers by domain/resource
- Use queries for reads, mutations for writes
- Leverage TypeScript inference for end-to-end type safety
{{/style:trpc}}

{{#style:grpc}}
### gRPC Guidelines
- Define service and message types in proto3 syntax
- Use streaming where appropriate (server, client, or bidirectional)
- Plan proper error codes (OK, INVALID_ARGUMENT, NOT_FOUND, etc.)
- Consider deadline/timeout propagation
{{/style:grpc}}

{{#style:websocket}}
### WebSocket Guidelines
- Define message types/events with clear schemas
- Plan connection lifecycle: open, message, error, close
- Design heartbeat/ping-pong for connection health
- Handle reconnection and message ordering
{{/style:websocket}}

{{#output:design-only}}
### Output: Design Only
Produce a detailed API design document with endpoint/operation definitions, TypeScript types, and documentation. Do not write implementation code.
{{/output:design-only}}

{{#output:implement}}
### Output: Implementation
Implement the API with full working code, types, error handling, and inline documentation.
{{/output:implement}}

{{#output:both}}
### Output: Design + Implementation
First produce the API design document, then implement it with full working code.
{{/output:both}}

## Additional Notes
{{notes}}`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Describe the API to design or implement",
      required: true,
    },
    {
      name: "style",
      label: "API Style",
      type: "select",
      defaultValue: "rest",
      options: [
        { value: "rest", label: "REST" },
        { value: "graphql", label: "GraphQL" },
        { value: "trpc", label: "tRPC" },
        { value: "grpc", label: "gRPC" },
        { value: "websocket", label: "WebSocket" },
      ],
    },
    {
      name: "auth_method",
      label: "Authentication",
      type: "select",
      defaultValue: "none",
      options: [
        { value: "none", label: "None" },
        { value: "jwt", label: "JWT" },
        { value: "api-key", label: "API Key" },
        { value: "oauth2", label: "OAuth 2.0" },
        { value: "session", label: "Session" },
      ],
    },
    {
      name: "output",
      label: "Output",
      type: "select",
      defaultValue: "both",
      options: [
        { value: "design-only", label: "Design Only" },
        { value: "implement", label: "Implement" },
        { value: "both", label: "Both" },
      ],
    },
    {
      name: "notes",
      label: "Additional Notes",
      type: "textarea",
      placeholder: "Constraints or existing patterns to follow (optional)",
    },
  ],
};
