import { useId, type ChangeEvent } from "react";
import type { SkillTemplate } from "../../../skills/types.ts";

/** Accessible variable fields for one selected skill. */
export function SkillVariableInputs({
  skill,
  values,
  onChange,
  readOnly,
}: {
  skill: SkillTemplate;
  values: Record<string, string>;
  onChange: (varName: string, value: string) => void;
  readOnly: boolean;
}) {
  const idPrefix = useId();
  if (skill.variables.length === 0) return null;

  return (
    <div className="skill-variable-inputs">
      {skill.variables.map((variable) => {
        const inputId = `${idPrefix}-${variable.name}`;
        const descriptionId = variable.description
          ? `${inputId}-description`
          : undefined;
        const commonProps = {
          id: inputId,
          value: values[variable.name] ?? variable.defaultValue ?? "",
          onChange: (
            event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
          ) => onChange(variable.name, event.target.value),
          "aria-describedby": descriptionId,
          "aria-required": variable.required || undefined,
        };

        return (
          <div className="skill-variable-inputs__field" key={variable.name}>
            <label htmlFor={inputId}>
              {variable.label}
              {variable.required && (
                <span title="Required" aria-label="required">*</span>
              )}
            </label>
            {variable.type === "select" ? (
              <select {...commonProps} disabled={readOnly}>
                {variable.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : variable.type === "textarea" ? (
              <textarea
                {...commonProps}
                readOnly={readOnly}
                placeholder={variable.placeholder}
                rows={3}
              />
            ) : (
              <input
                {...commonProps}
                type="text"
                readOnly={readOnly}
                placeholder={variable.placeholder}
              />
            )}
            {variable.description && (
              <span id={descriptionId}>{variable.description}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
