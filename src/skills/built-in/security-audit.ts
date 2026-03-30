import type { SkillTemplate } from "../types.ts";

export const securityAuditSkill: SkillTemplate = {
  id: "security-audit",
  name: "Security Audit",
  description:
    "Scan code for security vulnerabilities, injection risks, and unsafe patterns.",
  category: "analysis",
  icon: "🛡️",
  accentColor: "#f87171",
  template: `# Security Audit

You are performing a thorough security audit of the target code.

## Target
{{target}}

## Focus Area: {{focus}}

## Instructions

### Vulnerability Scanning
- Scan for **XSS** (cross-site scripting): unsanitized output, innerHTML, dangerouslySetInnerHTML
- Scan for **SQL injection**: raw queries, string interpolation in SQL, missing parameterization
- Scan for **CSRF**: missing tokens, unsafe state-changing GET requests
- Scan for **Path traversal**: unsanitized file paths, directory traversal sequences (../)

### Authentication & Authorization
- Review authentication flows for weaknesses (weak hashing, missing rate limiting, session fixation)
- Check authorization patterns — ensure proper role/permission checks on all protected routes
- Verify token handling (JWT validation, expiration, refresh logic)

### Input Validation & Sanitization
- Identify endpoints or functions accepting user input without validation
- Check for missing type coercion, length limits, and format validation
- Review deserialization of untrusted data (JSON.parse, eval, pickle, etc.)

### Secrets & Credentials
- Identify hardcoded secrets, API keys, passwords, or tokens in source code
- Check for credentials in config files, environment variable misuse, or committed .env files
- Flag any sensitive data logged or exposed in error messages

### Dependency Security
- Review dependencies for known vulnerabilities
- Flag outdated packages with security patches available
- Check for typosquatting or suspicious dependency names

### Access Control & Permissions
- Review file system permissions and access boundaries
- Check for privilege escalation paths
- Verify principle of least privilege in service accounts and API scopes

## Severity Threshold: {{severity_threshold}}
{{#severity_threshold:all}}Report all findings from low informational notes to critical vulnerabilities.{{/severity_threshold:all}}
{{#severity_threshold:high-and-above}}Only report high and critical severity findings.{{/severity_threshold:high-and-above}}
{{#severity_threshold:critical-only}}Only report critical severity findings — actively exploitable vulnerabilities.{{/severity_threshold:critical-only}}

## Output Format
For each finding:
1. **Severity**: critical / high / medium / low
2. **Category**: (e.g., XSS, SQL Injection, Hardcoded Secret)
3. **Location**: exact file path and line number
4. **Description**: what the vulnerability is and why it matters
5. **Suggested Fix**: concrete code change or mitigation

End with an overall security posture summary and prioritized remediation plan.

## Known Risks / Notes
{{notes}}`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Code, files, directories, or area to audit",
      required: true,
    },
    {
      name: "focus",
      label: "Focus Area",
      type: "select",
      defaultValue: "comprehensive",
      options: [
        { value: "comprehensive", label: "Comprehensive" },
        { value: "web-security", label: "Web Security" },
        { value: "auth", label: "Authentication & Authorization" },
        { value: "dependencies", label: "Dependencies" },
        { value: "secrets", label: "Secrets & Credentials" },
      ],
    },
    {
      name: "severity_threshold",
      label: "Severity Threshold",
      type: "select",
      defaultValue: "all",
      options: [
        { value: "all", label: "All Findings" },
        { value: "high-and-above", label: "High & Above" },
        { value: "critical-only", label: "Critical Only" },
      ],
    },
    {
      name: "notes",
      label: "Known Risks / Notes",
      type: "textarea",
      placeholder: "Known risks or areas of concern (optional)",
    },
  ],
};
