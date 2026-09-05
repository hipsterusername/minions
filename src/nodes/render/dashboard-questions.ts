import type { RenderComponent } from "../../../shared/render-dsl.ts";
import type { FormComponent } from "../../../shared/render-form.ts";

/** Lift pending questions out of every container, including hidden tabs. */
export function partitionDashboardQuestions(
  components: RenderComponent[],
  submitted: ReadonlyMap<string, Record<string, unknown>>,
): { questions: FormComponent[]; components: RenderComponent[] } {
  const questions: FormComponent[] = [];
  function visit(items: RenderComponent[]): RenderComponent[] {
    return items.flatMap((component): RenderComponent[] => {
      if (component.type === "form") {
        const answers = component.submittedAnswers ?? submitted.get(component.id);
        if (answers == null) {
          questions.push(component);
          return [];
        }
        return [{ ...component, submittedAnswers: answers }];
      }
      if (component.type === "section") {
        const children = visit(component.components);
        if (component.components.length > 0 && children.length === 0) return [];
        return [{ ...component, components: children }];
      }
      if (component.type === "tabs") {
        const tabs = component.tabs.flatMap((tab) => {
          const children = visit(tab.components);
          return tab.components.length > 0 && children.length === 0
            ? []
            : [{ ...tab, components: children }];
        });
        if (component.tabs.length > 0 && tabs.length === 0) return [];
        return [{ ...component, tabs }];
      }
      return [component];
    });
  }
  const dashboardComponents = visit(components);
  return { questions, components: dashboardComponents };
}
