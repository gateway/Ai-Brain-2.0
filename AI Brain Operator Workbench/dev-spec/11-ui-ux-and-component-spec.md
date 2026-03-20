# 11 — UI/UX and Component Spec

## Goal

Describe enough UI detail that the app does not feel vague to engineers or designers.

## Design character

The UI should feel:
- operator-oriented
- clear
- technical but not ugly
- graph-capable
- trustworthy
- inspectable

Recommended style:
- modern, clean, dark-friendly
- top navigation
- strong detail drawers
- status badges
- table + card hybrid layouts
- minimal clutter

## Core layout

### App shell
- top nav
- content container
- optional right-side info drawer on detail-heavy pages
- consistent breadcrumbs for session pages

### Session shell
For session routes:
- session title
- session status badge
- session subnav
- actions menu:
  - re-run classification
  - trigger consolidation
  - export session summary
  - archive session

## Major components

## 1. Session table
Columns:
- title
- status
- created
- updated
- inputs
- open review items
- open clarifications
- actions

## 2. Intake card set
Cards or tabs for:
- Paste Text
- Record Audio
- Upload Files

Each card should clearly describe:
- what it accepts
- what will happen
- optional model settings

## 3. Upload queue list
Per file:
- icon by file type
- file name
- size
- progress
- status badge
- retry/remove action
- pipeline state text

## 4. Model options panel
Fields:
- ASR model selector
- LLM model selector
- preset selector
- system prompt override editor
- advanced settings accordion

## 5. Text/transcript viewer
Features:
- large readable text
- segment/chunk toggles
- source snippet highlighting
- copy text
- raw/clean toggle if useful

## 6. Review cards
Card types:
- entity candidate card
- relationship candidate card
- claim card
- unresolved item card

Each should support:
- confidence badge
- expand details
- quick action buttons
- evidence preview

## 7. Clarification workspace
Two-pane recommended layout:

### Left
List of open items with filters.

### Right
Focused resolution panel with:
- evidence
- candidate matches
- form actions
- notes
- submit

## 8. Graph explorer
Main canvas with toolbar.

Toolbar actions:
- fit
- reset
- filter
- search node
- expand selected
- show only unresolved
- export image optional later

Node interaction:
- click opens side panel
- double click expands
- right click optional context menu

## 9. Query editor
For SQL/prompt editors use Monaco or equivalent.

SQL editor requirements:
- monospace
- syntax highlight
- run button
- save query
- row limit display
- safe mode notice

## 10. Model lab panels
Tabs:
- Runtime status
- ASR test
- Chat test
- Embeddings test
- Presets
- Registry

## Status badges

Suggested badges:
- Draft
- Queued
- Running
- Succeeded
- Failed
- Awaiting Review
- Clarifications Open
- Reprocessing
- Unsupported
- Awaiting Adapter

Color semantics should be consistent but do not rely only on color.

## Empty states

Examples:

### No sessions
“Create your first session to start ingesting material into AI Brain.”

### No clarifications
“No unresolved identity or relationship issues were found for this session.”

### No graph
“No graphable entities or relationships have been produced yet.”

### No transcript
“This artifact has no derived text yet.”

## Error states

Every page must show:
- plain-English explanation
- retry or next action
- technical detail accordion for engineers

Example:
“Transcript generation failed. The ASR runtime could not be reached.”
Details:
- endpoint
- timestamp
- request id or run id if available

## Accessibility

Must support:
- keyboard navigation on forms
- sufficient contrast
- labels for buttons and inputs
- accessible modals/drawers
- non-color status indicators
- large enough click targets

## Responsive behavior

Desktop-first is acceptable for MVP, but pages should still function on smaller widths.

Recommended small-screen strategy:
- stack sidebars below content
- keep graph desktop-preferred
- keep query/model lab usable but simplified

## UX requirements by page

### Sessions list
- fast scanning
- searchable
- sortable by updated date and status

### Intake page
- no ambiguity about what happens on submit
- persistent status feedback
- clear file-level outcomes

### Review page
- easy to tell “what the system thinks”
- easy to jump to evidence

### Clarifications page
- easy to resolve uncertainty
- no hidden required steps

### Graph page
- visually pleasing but legible
- provenance always within reach

### Query page
- power-user friendly
- safe and explicit

## Nice-to-have UI enhancements

- diff view before/after reprocessing
- inline source snippet highlighting from graph node clicks
- sticky status summary on session pages
- hotkeys for next unresolved item
