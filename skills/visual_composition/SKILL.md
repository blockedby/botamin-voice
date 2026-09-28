---
name: Visual Composition Quality
alias: visual_composition
description: Design and refine product-quality visual surfaces: composition, design-system continuity, responsive transformation, UI states, motion, and feedback.
type: tools: designer
subtype: ui
tags: ui, composition, design-system, responsive, states, motion
author: PO
---

# Visual Composition Quality

Use this skill to decide what visual surface to build and to guide its implementation. The same principles may support review by comparing the rendered result with the intended design, but this skill does not define screenshot collection, scoring, verdicts, artifact paths, or report formats. Use the dedicated browser/reporting and acceptance skills for those concerns.

## Core principles

1. **Design against a brief, not generic taste.** Establish the audience and usage scenario, purpose, primary task, required content, references, and constraints before choosing a visual direction. Design succeeds by helping a particular person accomplish something.
2. **Make the interface guide the user.** Use hierarchy, spacing, grouping, color, imagery, and motion to show what matters, what belongs together, what changed, and where to go next. Every prominent element should provide meaning, orientation, emphasis, feedback, or a clear next step.
3. **Preserve a coherent system while adapting it to the task.** Reuse tokens, components, and proven structures, but adapt hierarchy, imagery, density, and interaction to the specific content. Pure repetition feels generic; unconstrained novelty feels inconsistent and makes the interface harder to learn.
4. **Design the complete experience, not only the ideal frame.** Treat loading, empty, partial, error, success, disabled, pending, and expanded states as parts of the composition. A polished default state cannot compensate for confusing transitions or neglected edge states.
5. **Render, inspect, and refine.** Compare the actual rendered surface with the intended goal and correct the visible gap. Source code and abstract metrics cannot show the complete visual result.
6. **Express decisions as user-facing outcomes.** Explain what the user should notice, understand, feel, or do rather than relying on labels such as `premium`, `clean`, `generic`, or `modern`.

## Required inputs

Collect or explicitly mark missing:

- audience and target usage scenario;
- purpose: why the surface exists;
- primary task: what the user must do on it;
- required content, data, interactions, and UI states;
- reference screenshots, adjacent product surfaces, existing components, design tokens, and brand rules;
- supported viewport range, breakpoints, themes, locales, and input methods;
- available imagery, icons, charts, mockups, and other assets;
- product, technical, content, and accessibility constraints.

Do not invent brand rules, product claims, information architecture, or a visual direction when the supplied context does not support them. Preserve uncertainty as an explicit design question.

## Design brief

Record the smallest useful brief before implementation:

```md
Audience and usage scenario:
Purpose:
Primary user task:
Required content and states:
Reference surfaces:
Design-system invariants:
Composition strategy:
Visual signature:
Responsive transformation:
Motion and feedback intent:
Forbidden or discouraged outcomes:
```

Make the brief concrete enough that another implementer can explain why the selected composition fits the content and task.

## Choose a composition pattern by purpose

Choose a pattern because it matches the information relationship, not because it is fashionable.

| Purpose | Useful starting pattern | Composition intent |
| --- | --- | --- |
| Explain and persuade | Hero plus proof | Lead with one message and action; follow with evidence, not unrelated decoration. |
| Compare alternatives | Aligned comparison | Keep shared attributes aligned, expose meaningful differences, and explain any recommendation. |
| Monitor or operate | Dashboard hierarchy | Show status and exceptions first, then controls and detail; do not give every card equal weight. |
| Complete a task | Form flow | Group fields by decision, reveal complexity progressively, and keep errors and help near their cause. |
| Teach or tell a story | Editorial/content-first flow | Preserve reading measure, narrative order, media relevance, and section rhythm. |
| Explore related detail | Master-detail or split panel | Keep selection and context connected; collapse them into a clear sequence on narrow screens. |
| Browse peer items | Card or list collection | Use repeated containers only when items are genuinely comparable peers. |

A named pattern is a starting structure, not permission to copy an unrelated template. Change or combine patterns when the content relationship requires it.

## Design-system continuity

- Inspect existing tokens, layout wrappers, components, interaction patterns, and nearby surfaces before adding new visual rules.
- Reuse established typography, spacing, color, radius, elevation, and icon systems unless the brief explicitly calls for a change.
- Give each token family a stable role: primary action, supporting action, surface, boundary, emphasis, success, warning, and error.
- Keep the number of type levels, spacing increments, accent colors, and surface treatments intentional. More variation does not create more hierarchy.
- Reuse a component when its semantics and behavior match. Do not force different content into one component only to maximize reuse.
- Adapt proven structures to the prompt through content hierarchy, imagery, density, interaction, and responsive behavior rather than superficial recoloring.
- Preserve recognizable product identity across breakpoints, themes, states, and new sections.

## Guide attention and flow

- Establish one clear visual starting point for each page or major region.
- Use several consistent cues—position, size, contrast, spacing, and typography—to express importance. Do not rely on color alone.
- Place related elements close together and align them to shared edges or baselines. Use whitespace to separate different decisions or topics.
- Order content according to the user's next decision: orientation, relevant information, action, then confirmation or consequence.
- Keep primary, secondary, and destructive actions visually distinct. Avoid several controls competing as the main action.
- Make navigation, progress, selection, and state changes visible without forcing the user to remember previous screens.
- Let visual character reinforce purpose and tone, but do not let decoration compete with content or actions.
- Give every prominent element a role in meaning, orientation, emphasis, feedback, or flow.

## Responsive transformation

- Recompose instead of merely shrinking. Collapse columns, reorder supporting content, simplify decoration, and preserve the primary task.
- Choose breakpoints where the content needs a different relationship, while respecting the project's existing breakpoint system.
- Preserve reading order and task order when side-by-side regions become sequential.
- Use grid and flex layout before measuring positions in JavaScript.
- Allow text, controls, cards, and media to shrink or wrap without clipping required content.
- Keep narrow layouts readable and usable without unintended horizontal scrolling. Fix the overflowing element rather than hiding the page overflow.
- Avoid stretched desktop layouts on mobile and sparse, unbounded compositions on wide screens. Set purposeful content measures and container limits.
- Respect safe areas for full-bleed surfaces, sticky controls, sheets, and bottom actions.
- Keep touch targets and gaps large enough to avoid accidental activation, especially near viewport edges.

## UI states and feedback

Design the relevant states before polishing the default state:

- default, loading, empty, partial-data, error, success, disabled, pending, selected, expanded, submitting, and permission-denied;
- hover, focus-visible, active, checked, dragged, and validation states where interaction requires them;
- short, typical, long, missing, and malformed content where the product can produce it.

Apply these patterns:

- Keep the stable page shell visible when only one region is waiting for data.
- Localize loading and error feedback to the region that is changing.
- Match skeleton geometry to the final content so loading does not rewrite the composition.
- Keep controls responsive immediately; defer non-urgent results rather than blocking typing, toggling, or navigation.
- Preserve useful previous content during refresh when it helps orientation, and mark it as pending instead of flashing an empty surface.
- Place errors near their cause and include the next corrective action.
- Confirm successful actions in context without obscuring the user's next step.
- Preserve component state when temporary hiding and showing should not reset the user's work.
- Warn before losing unsaved work and provide confirmation or undo for destructive actions.

## Content and typography

- Design with realistic content, not equal-length placeholder copy.
- Test mentally and during implementation with short, typical, and long labels, titles, values, descriptions, and user-generated content.
- Keep headings scannable and body text within a readable measure. Use balanced or pretty wrapping for prominent text when supported.
- Avoid one-word-per-line headings, accidental widows, cramped leading, and arbitrary font-size jumps.
- Truncate or clamp only when the loss is intentional and the full value remains available when needed.
- Allow flex and grid children to shrink correctly; use wrapping or `min-width: 0` where long content would otherwise force overflow.
- Use tabular numerals for aligned metrics, prices, comparisons, timers, and changing numeric values.
- Format dates, times, numbers, and currency for the active locale rather than hardcoding presentation.
- Use specific action labels such as `Save API Key` or `Choose Pro`, not generic labels such as `Continue` when the action can be named.
- Make empty states explain what is absent, why it matters, and what the user can do next.
- Keep product claims, labels, and supporting copy factual; visual polish must not compensate for invented content.

## Interaction and forms

- Use buttons for actions and links for navigation. Do not make generic containers behave like controls.
- Give every interactive element a visible hover, active, focus-visible, disabled, and pending treatment when applicable.
- Make interactive states more prominent than resting states rather than lowering their contrast.
- Give icon-only controls an accessible name and make decorative icons silent to assistive technology.
- Pair each form control with a visible label; keep the label and control inside one coherent hit area where appropriate.
- Use the correct input type and input mode, and allow paste.
- Keep submit actions available until submission begins, then show a stable pending state without changing the button's meaning.
- Place validation beside the affected field and move focus to the first actionable error after submission.
- Use autofocus sparingly; avoid forcing it on mobile or when it would unexpectedly move the viewport.
- Keep filters, tabs, pagination, and other meaningful navigational state shareable and recoverable when the product architecture supports it.
- Contain scroll and overscroll inside modals, drawers, and sheets without trapping keyboard focus.

## Motion and media

- Use motion to explain appearance, disappearance, reordering, hierarchy, progress, or spatial relationship.
- Keep animations interruptible and responsive to new input.
- Provide a reduced-motion treatment that preserves meaning without unnecessary movement.
- Prefer animating transform and opacity; avoid broad `transition: all` rules.
- Set a deliberate transform origin and animate a wrapper when direct SVG animation would be unstable or inefficient.
- Avoid permanent ambient motion near reading, forms, or primary actions unless it carries essential information.
- Give images and media explicit dimensions or aspect ratios so the layout reserves their final space.
- Choose crops intentionally and preserve the subject across responsive variants.
- Prioritize critical above-the-fold media and defer below-the-fold media.
- Use alternative text for meaningful images and empty alternative text for purely decorative images.
- Keep charts and data graphics legible, truthful, labeled, and useful without depending on decorative effects.

## Perceived performance

- Make the first visible frame coherent: avoid flashing the wrong theme, authentication state, locale, or placeholder before the correct state appears.
- Render the stable wrapper immediately when only a nested region depends on slow data.
- Reserve space for asynchronous content to avoid layout shifts.
- Preload a heavy interaction on clear user intent, such as hover or focus, when doing so materially reduces delay.
- Defer non-critical scripts, decoration, and below-the-fold media that compete with the primary task.
- Keep typing, scrolling, selection, and navigation responsive while expensive results or visualizations update.
- Virtualize or defer offscreen rendering for long collections instead of making the initial composition wait for every item.
- Do not hide latency with distracting animation. Show where work is happening and keep unaffected areas usable.

## Creation anti-patterns

Avoid these outcomes unless the brief supplies a specific reason:

- applying a hero, bento grid, card collection, gradient, or oversized heading before understanding the content relationship;
- giving every section, card, action, or metric equal visual weight;
- using decoration, floating objects, glow, or motion that provides no meaning or orientation;
- producing a composition that could serve an unrelated product after only replacing text and colors;
- introducing one-off typography, spacing, radius, shadow, or interaction rules beside an established system;
- forcing narrative, hierarchical, or sequential content into interchangeable cards;
- shrinking a desktop composition onto mobile without reordering or simplifying it;
- masking overflow with `overflow-x: hidden` instead of fixing the responsible element;
- replacing the entire surface with a spinner when only one region is loading;
- using skeletons whose geometry does not match the final content;
- flashing an incorrect theme, user state, or layout during initialization;
- omitting empty, error, pending, long-content, or reduced-motion behavior;
- using placeholder-only copy, invented metrics, broken assets, or generic actions as final content;
- using animation as polish when hierarchy, grouping, content, or interaction remains unclear;
- making controls visually attractive but ambiguous, unlabeled, keyboard-inaccessible, or too small to use reliably.

## Creation loop

1. Read the brief, references, existing components, and design tokens.
2. Choose a composition pattern that matches the content relationship and primary task.
3. Define hierarchy, reading order, grouping, actions, and visual flow before decoration.
4. Define responsive transformations and important UI states before polishing the ideal desktop state.
5. Implement with existing primitives and semantic interaction patterns.
6. Render representative widths, states, and realistic content while implementation is still easy to change.
7. Fix the most obvious hierarchy, flow, content, state, and responsive problems before adding finishing details.
8. Refine typography, spacing, imagery, motion, and perceived performance without weakening clarity or accessibility.

## Creation handoff

When this skill is used by itself, return only:

- the completed design brief and any unresolved design questions;
- the chosen composition pattern and why it fits;
- hierarchy, grouping, reading order, and primary-action decisions;
- UI-state and feedback behavior;
- responsive transformation;
- relevant implementation patterns, reuse targets, and anti-patterns to avoid.

Do not produce a screenshot plan, viewport matrix, worst-screenshot ranking, severity score, verdict, acceptance audit, or visual report. Keep those artifacts in the dedicated browser/reporting and acceptance skills. During creation, inspect the rendered UI only to refine the implementation; do not turn that refinement loop into a reporting workflow.
