import type { SkillTemplate } from "../types.ts";

export const frontendDesignSkill: SkillTemplate = {
  id: "frontend-design",
  name: "Frontend Design",
  description:
    "Design and implement beautiful, responsive frontend UIs with modern best practices.",
  category: "design",
  icon: "🎨",
  accentColor: "#a78bfa",
  template: `# Frontend Design

You are designing and implementing a frontend UI component or page.

## Target
{{target}}

## Framework: {{framework}}
{{#framework:auto-detect}}Auto-detect the framework from the existing codebase.{{/framework:auto-detect}}

## Styling Approach: {{style_approach}}

## Design System
{{design_system}}

## Instructions

### Accessibility
- Use semantic HTML elements (\`<nav>\`, \`<main>\`, \`<article>\`, \`<section>\`, \`<aside>\`, etc.)
- Add ARIA labels, roles, and attributes where semantic HTML is insufficient
- Ensure keyboard navigation works correctly (focus order, focus trapping in modals)
- Maintain sufficient color contrast ratios (WCAG AA minimum)
- Provide alt text for images and aria-labels for icon-only buttons

### Modern CSS
- Prefer CSS Grid for two-dimensional layouts and Flexbox for one-dimensional alignment
- Use CSS custom properties (variables) for theming and design tokens
- Use logical properties (\`inline\`, \`block\`) over physical ones where appropriate
- Leverage modern selectors (\`:has()\`, \`:is()\`, \`:where()\`) when beneficial
- Avoid magic numbers — derive spacing and sizing from a consistent scale

### Responsive Design
- Follow a mobile-first approach: start with the smallest breakpoint and layer up
- Use relative units (\`rem\`, \`em\`, \`%\`, \`dvh\`) over fixed pixels for sizing
- Use container queries when component-level responsiveness is needed
- Test layouts at common breakpoints (320px, 768px, 1024px, 1440px)
- Ensure touch targets are at least 44×44px on mobile

### Component Architecture
- Build small, composable, single-responsibility components
- Separate presentational components from logic/state containers
- Define clear prop interfaces with sensible defaults
- Support controlled and uncontrolled usage patterns where appropriate
- Keep component files focused — extract subcomponents when complexity grows

### UX & Micro-interactions
- Add transitions for state changes (hover, focus, active, disabled)
- Use loading skeletons or spinners for asynchronous content
- Provide clear visual feedback for user actions (button presses, form validation)
- Implement smooth scroll behavior and meaningful motion (\`prefers-reduced-motion\` respected)
- Design clear empty states, error states, and edge-case UIs

### Theming
- Support both light and dark color schemes via CSS custom properties or the framework's theming system
- Respect the user's system preference with \`prefers-color-scheme\`
- Ensure all UI elements remain readable and visually consistent across themes
- Define a token-based palette (background, surface, text, primary, secondary, border, etc.)

## Constraints
{{constraints}}`,
  variables: [
    {
      name: "target",
      label: "Target",
      type: "textarea",
      placeholder: "Describe what to design or build (e.g., dashboard layout, settings page, data table component)",
      required: true,
    },
    {
      name: "framework",
      label: "Framework",
      type: "select",
      defaultValue: "auto-detect",
      options: [
        { value: "auto-detect", label: "Auto-detect" },
        { value: "react", label: "React" },
        { value: "vue", label: "Vue" },
        { value: "svelte", label: "Svelte" },
        { value: "vanilla", label: "Vanilla JS/TS" },
      ],
    },
    {
      name: "style_approach",
      label: "Styling Approach",
      type: "select",
      defaultValue: "css-modules",
      options: [
        { value: "css-modules", label: "CSS Modules" },
        { value: "tailwind", label: "Tailwind CSS" },
        { value: "styled-components", label: "Styled Components" },
        { value: "inline-styles", label: "Inline Styles" },
        { value: "css-in-js", label: "CSS-in-JS" },
      ],
    },
    {
      name: "design_system",
      label: "Design System",
      type: "text",
      placeholder: "Design system or component library (e.g., Material UI, Radix, shadcn/ui)",
      description: "Optional design system or component library to build on top of.",
    },
    {
      name: "constraints",
      label: "Constraints",
      type: "textarea",
      placeholder: "Design constraints or requirements (e.g., must match existing brand colors, no JavaScript animations)",
      description: "Optional design constraints, brand guidelines, or specific requirements.",
    },
  ],
};
