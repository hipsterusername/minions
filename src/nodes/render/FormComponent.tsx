/**
 * FormComponent — interactive React renderer for the form render-DSL primitive.
 *
 * Props:
 *   component  — validated FormComponent (schema from shared/render-form.ts)
 *   onSubmit   — called with Record<string, unknown> when the form is submitted
 *
 * Behaviour:
 *   • Each field kind renders the appropriate HTML input element.
 *   • Validation (required, pattern, maxLength, min/max) runs on submit.
 *   • Per-field error messages are shown below the input on failure.
 *   • When component.submittedAnswers is set, the form is locked (read-only)
 *     and a green "Submitted ✓" badge replaces the submit button.
 *   • CSS variables match the existing RenderNode card styling.
 *
 * DO NOT register or import this from RenderNode.tsx — the Leader wires that in.
 */

import { useState } from "react";
import type { FormComponent, FormField } from "../../../shared/render-form.ts";

// ── Props ──────────────────────────────────────────────────

export interface FormComponentProps {
  component: FormComponent;
  onSubmit: (answers: Record<string, unknown>) => void;
}

// ── Helpers ────────────────────────────────────────────────

function optionValue(opt: string | { value: string; label: string }): string {
  return typeof opt === "string" ? opt : opt.value;
}

function optionLabel(opt: string | { value: string; label: string }): string {
  return typeof opt === "string" ? opt : opt.label;
}

function fieldDefaultValue(field: FormField): unknown {
  if (field.default !== undefined) return field.default;
  if (field.kind === "checkbox") return false;
  if (field.kind === "multiselect") return [];
  if (field.kind === "slider" || field.kind === "number") return field.min ?? 0;
  return "";
}

function buildInitialValues(fields: FormField[]): Record<string, unknown> {
  const vals: Record<string, unknown> = {};
  for (const f of fields) {
    vals[f.id] = fieldDefaultValue(f);
  }
  return vals;
}

function validateField(field: FormField, value: unknown): string | null {
  if (field.required) {
    if (field.kind === "checkbox") {
      if (!value) return `${field.label} is required`;
    } else if (field.kind === "multiselect") {
      if (!Array.isArray(value) || value.length === 0) {
        return `${field.label} requires at least one selection`;
      }
    } else {
      const str = String(value ?? "").trim();
      if (str.length === 0) return `${field.label} is required`;
    }
  }

  if (field.kind === "text" || field.kind === "textarea") {
    const str = String(value ?? "");
    if (field.maxLength != null && str.length > field.maxLength) {
      return `${field.label} must be at most ${field.maxLength} characters`;
    }
    if (field.pattern != null && str.length > 0) {
      try {
        const re = new RegExp(field.pattern);
        if (!re.test(str)) {
          return `${field.label} does not match the required format`;
        }
      } catch {
        // Malformed pattern from agent — skip silently
      }
    }
  }

  if (field.kind === "number" || field.kind === "slider") {
    const num = Number(value);
    if (field.min != null && num < field.min) {
      return `${field.label} must be at least ${field.min}`;
    }
    if (field.max != null && num > field.max) {
      return `${field.label} must be at most ${field.max}`;
    }
  }

  return null;
}

// ── Field renderers ────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: 12,
  fontFamily: "inherit",
  background: "var(--bg-elevated, #1e1e1e)",
  border: "1px solid var(--border-default, #333)",
  borderRadius: 5,
  color: "var(--text-primary, #e0e0e0)",
  boxSizing: "border-box",
};

const disabledStyle: React.CSSProperties = {
  ...inputStyle,
  opacity: 0.65,
  cursor: "not-allowed",
};

function fieldDescriptionId(field: FormField): string {
  return `${field.id}-description`;
}

function fieldErrorId(field: FormField): string {
  return `${field.id}-error`;
}

function fieldDescribedBy(field: FormField, error: string | null): string | undefined {
  const ids: string[] = [];
  if (field.description) ids.push(fieldDescriptionId(field));
  if (error) ids.push(fieldErrorId(field));
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function fieldAriaProps(field: FormField, error: string | null) {
  return {
    "aria-describedby": fieldDescribedBy(field, error),
    "aria-invalid": error ? true : undefined,
    "aria-required": field.required ? true : undefined,
  };
}

const fieldWrapperStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-secondary, #aaa)",
  letterSpacing: "0.02em",
};

function RequiredMarker() {
  return (
    <span
      aria-hidden="true"
      style={{ color: "var(--status-error, #e05252)", marginLeft: 3 }}
    >
      *
    </span>
  );
}

function FieldWrapper({
  field,
  error,
  children,
  asFieldset = false,
}: {
  field: FormField;
  error: string | null;
  children: React.ReactNode;
  asFieldset?: boolean;
}) {
  const description = field.description && (
    <div
      id={fieldDescriptionId(field)}
      style={{
        fontSize: 10,
        color: "var(--text-muted, #666)",
        lineHeight: 1.5,
      }}
    >
      {field.description}
    </div>
  );
  const errorMessage = error && (
    <div
      id={fieldErrorId(field)}
      role="alert"
      style={{
        fontSize: 10,
        color: "var(--status-error, #e05252)",
        marginTop: 2,
      }}
    >
      {error}
    </div>
  );

  if (asFieldset) {
    return (
      <fieldset
        id={field.id}
        aria-describedby={fieldDescribedBy(field, error)}
        aria-invalid={error ? true : undefined}
        aria-required={field.required ? true : undefined}
        style={{
          ...fieldWrapperStyle,
          margin: 0,
          padding: 0,
          border: "none",
          minInlineSize: 0,
        }}
      >
        <legend style={{ ...fieldLabelStyle, padding: 0 }}>
          {field.label}
          {field.required && <RequiredMarker />}
        </legend>
        {description}
        {children}
        {errorMessage}
      </fieldset>
    );
  }

  return (
    <div style={fieldWrapperStyle}>
      <label htmlFor={field.id} style={fieldLabelStyle}>
        {field.label}
        {field.required && <RequiredMarker />}
      </label>
      {description}
      {children}
      {errorMessage}
    </div>
  );
}

function TextField({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <FieldWrapper field={field} error={error}>
      <input
        id={field.id}
        type="text"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        maxLength={field.maxLength}
        disabled={disabled}
        required={field.required}
        {...fieldAriaProps(field, error)}
        style={disabled ? disabledStyle : inputStyle}
      />
    </FieldWrapper>
  );
}

function TextareaField({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <FieldWrapper field={field} error={error}>
      <textarea
        id={field.id}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        maxLength={field.maxLength}
        disabled={disabled}
        required={field.required}
        {...fieldAriaProps(field, error)}
        rows={4}
        style={{ ...( disabled ? disabledStyle : inputStyle), resize: "vertical" }}
      />
    </FieldWrapper>
  );
}

function NumberField({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: number) => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <FieldWrapper field={field} error={error}>
      <input
        id={field.id}
        type="number"
        value={String(value ?? "")}
        onChange={(e) => onChange(Number(e.target.value))}
        min={field.min}
        max={field.max}
        step={field.step}
        disabled={disabled}
        required={field.required}
        {...fieldAriaProps(field, error)}
        style={disabled ? disabledStyle : inputStyle}
      />
    </FieldWrapper>
  );
}

function SelectField({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
  disabled: boolean;
  error: string | null;
}) {
  const options = field.options ?? [];
  return (
    <FieldWrapper field={field} error={error}>
      <select
        id={field.id}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={field.required}
        {...fieldAriaProps(field, error)}
        style={disabled ? disabledStyle : inputStyle}
      >
        {!field.required && <option value="">— select —</option>}
        {options.map((opt) => (
          <option key={optionValue(opt)} value={optionValue(opt)}>
            {optionLabel(opt)}
          </option>
        ))}
      </select>
    </FieldWrapper>
  );
}

function MultiselectField({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string[]) => void;
  disabled: boolean;
  error: string | null;
}) {
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const options = field.options ?? [];

  function toggle(val: string) {
    if (selected.includes(val)) {
      onChange(selected.filter((v) => v !== val));
    } else {
      onChange([...selected, val]);
    }
  }

  return (
    <FieldWrapper field={field} error={error} asFieldset>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 5,
          padding: "6px 10px",
          background: "var(--bg-elevated, #1e1e1e)",
          border: "1px solid var(--border-default, #333)",
          borderRadius: 5,
        }}
      >
        {options.map((opt) => {
          const val = optionValue(opt);
          const lbl = optionLabel(opt);
          const checked = selected.includes(val);
          return (
            <label
              key={val}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--text-primary, #e0e0e0)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.65 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(val)}
                disabled={disabled}
                aria-describedby={fieldDescribedBy(field, error)}
                style={{ accentColor: "var(--accent, #6c8ebf)" }}
              />
              {lbl}
            </label>
          );
        })}
      </div>
    </FieldWrapper>
  );
}

function SliderField({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: number) => void;
  disabled: boolean;
  error: string | null;
}) {
  const num = typeof value === "number" ? value : Number(value ?? field.min ?? 0);
  return (
    <FieldWrapper field={field} error={error}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          id={field.id}
          type="range"
          value={num}
          onChange={(e) => onChange(Number(e.target.value))}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          {...fieldAriaProps(field, error)}
          style={{
            flex: 1,
            accentColor: "var(--accent, #6c8ebf)",
            cursor: disabled ? "not-allowed" : undefined,
          }}
        />
        <span
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--text-primary, #e0e0e0)",
            minWidth: 32,
            textAlign: "right",
          }}
        >
          {num}
        </span>
      </div>
    </FieldWrapper>
  );
}

function CheckboxField({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: boolean) => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <FieldWrapper field={field} error={error}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--text-primary, #e0e0e0)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.65 : 1,
        }}
      >
        <input
          id={field.id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          required={field.required}
          {...fieldAriaProps(field, error)}
          style={{ accentColor: "var(--accent, #6c8ebf)" }}
        />
        {field.description ?? field.label}
      </label>
    </FieldWrapper>
  );
}

function DateField({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <FieldWrapper field={field} error={error}>
      <input
        id={field.id}
        type="date"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={field.required}
        {...fieldAriaProps(field, error)}
        style={disabled ? disabledStyle : inputStyle}
      />
    </FieldWrapper>
  );
}

// ── Field dispatcher ───────────────────────────────────────

function FormFieldView({
  field,
  value,
  onValueChange,
  disabled,
  error,
}: {
  field: FormField;
  value: unknown;
  onValueChange: (id: string, v: unknown) => void;
  disabled: boolean;
  error: string | null;
}) {
  switch (field.kind) {
    case "text":
      return (
        <TextField
          field={field}
          value={value}
          onChange={(v) => onValueChange(field.id, v)}
          disabled={disabled}
          error={error}
        />
      );
    case "textarea":
      return (
        <TextareaField
          field={field}
          value={value}
          onChange={(v) => onValueChange(field.id, v)}
          disabled={disabled}
          error={error}
        />
      );
    case "number":
      return (
        <NumberField
          field={field}
          value={value}
          onChange={(v) => onValueChange(field.id, v)}
          disabled={disabled}
          error={error}
        />
      );
    case "select":
      return (
        <SelectField
          field={field}
          value={value}
          onChange={(v) => onValueChange(field.id, v)}
          disabled={disabled}
          error={error}
        />
      );
    case "multiselect":
      return (
        <MultiselectField
          field={field}
          value={value}
          onChange={(v) => onValueChange(field.id, v)}
          disabled={disabled}
          error={error}
        />
      );
    case "slider":
      return (
        <SliderField
          field={field}
          value={value}
          onChange={(v) => onValueChange(field.id, v)}
          disabled={disabled}
          error={error}
        />
      );
    case "checkbox":
      return (
        <CheckboxField
          field={field}
          value={value}
          onChange={(v) => onValueChange(field.id, v)}
          disabled={disabled}
          error={error}
        />
      );
    case "date":
      return (
        <DateField
          field={field}
          value={value}
          onChange={(v) => onValueChange(field.id, v)}
          disabled={disabled}
          error={error}
        />
      );
  }
}

// ── Main component ─────────────────────────────────────────

export function FormComponent({ component, onSubmit }: FormComponentProps) {
  const isLocked = component.submittedAnswers != null;

  const [values, setValues] = useState<Record<string, unknown>>(
    isLocked
      ? { ...buildInitialValues(component.fields), ...component.submittedAnswers }
      : buildInitialValues(component.fields),
  );
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  function handleValueChange(id: string, value: unknown): void {
    setValues((prev) => ({ ...prev, [id]: value }));
    // Clear error on change
    setErrors((prev) => ({ ...prev, [id]: null }));
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const nextErrors: Record<string, string | null> = {};
    let hasError = false;
    for (const field of component.fields) {
      const err = validateField(field, values[field.id]);
      nextErrors[field.id] = err;
      if (err) hasError = true;
    }
    setErrors(nextErrors);
    if (!hasError) {
      onSubmit({ ...values });
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-secondary, #161616)",
        border: "1px solid var(--border-default, #333)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      {(component.title || isLocked) && (
        <div
          style={{
            padding: "8px 14px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-default, #333)",
            background: "var(--bg-elevated, #1e1e1e)",
          }}
        >
          {component.title && (
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-primary, #e0e0e0)",
                letterSpacing: "-0.01em",
              }}
            >
              {component.title}
            </span>
          )}
          {isLocked && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--status-success, #4caf50)",
                background:
                  "color-mix(in srgb, var(--status-success, #4caf50) 12%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--status-success, #4caf50) 30%, transparent)",
                borderRadius: 10,
                padding: "2px 10px",
              }}
            >
              Submitted ✓
            </span>
          )}
        </div>
      )}

      {/* Description */}
      {component.description && (
        <div
          style={{
            padding: "8px 14px 0",
            fontSize: 11,
            color: "var(--text-secondary, #aaa)",
            lineHeight: 1.6,
          }}
        >
          {component.description}
        </div>
      )}

      {/* Fields */}
      <form onSubmit={handleSubmit} noValidate>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          {component.fields.map((field) => (
            <FormFieldView
              key={field.id}
              field={field}
              value={values[field.id]}
              onValueChange={handleValueChange}
              disabled={isLocked}
              error={errors[field.id] ?? null}
            />
          ))}
        </div>

        {/* Submit button — hidden when locked */}
        {!isLocked && (
          <div
            style={{
              padding: "0 14px 14px",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="submit"
              style={{
                padding: "7px 18px",
                fontSize: 12,
                fontWeight: 600,
                background: "var(--accent, #6c8ebf)",
                color: "var(--text-on-accent)",
                border: "none",
                borderRadius: 5,
                cursor: "pointer",
                letterSpacing: "0.02em",
              }}
            >
              {component.submitLabel ?? "Submit"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
