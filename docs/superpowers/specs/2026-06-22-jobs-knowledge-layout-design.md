# Jobs Knowledge-Style Layout

## Goal

Make the Jobs page follow the stable master/detail layout used by Knowledge. Selecting a job must keep the job list visible on the left and show readable details in the flexible right pane.

## Design

- Keep the existing Jobs surface header, filters, pagination, actions, and data flow.
- Replace the five-column master table with a compact selectable job list showing type, effective state, attempts, and age.
- Render job details in the flexible right pane. When no explicit job is selected, preview the first visible filtered job without changing provider state.
- Keep connected workers and active schedules below the master/detail workspace so their tables retain the full surface width.
- At widths below 1050px, stack the job list and detail pane and retain scroll-to-detail behavior after explicit selection.
- Preserve cancel, retry, accept-failure, filtering, pagination, worker-job selection, and polling behavior.

## Testing

- Add focused component tests for the two-pane structure, fallback preview, explicit selection, and operational sections outside the split.
- Run web type checking, focused tests, and the repository verification commands relevant to the changed files.
