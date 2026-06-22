# Jobs Separate Panels

## Goal

Split the Jobs page's three operational sections into separate visual panels, matching the Knowledge page's use of sibling surfaces for its main content and repository context.

## Design

- Keep `JobsPanel` as the page-level component and render three sibling `.surface` sections from it.
- The **Jobs** panel contains the existing job metrics, filters, master list, detail pane, pagination, and failure actions.
- The **Connected workers** panel contains worker and busy counts in its header and the existing worker table in its body.
- The **Active schedules** panel contains the schedule count in its header and the existing schedule table in its body.
- Remove the workers summary from the Jobs header because it belongs to the new workers panel.
- Preserve job selection from worker rows, polling updates, empty states, responsive behavior, and all existing actions.
- Reuse the established `.surface`, `.surfaceHeader`, and `.surfaceBody` structure rather than introducing a new panel abstraction.

## Testing

- Update the focused Jobs component test to assert that three sibling surfaces render in Jobs, workers, schedules order.
- Keep coverage for the Jobs master/detail workspace and explicit job selection.
- Run the focused component tests and web type checking.
