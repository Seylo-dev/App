// Shapes the screens pass around, taken from the op contracts' outputs so
// they never drift from what the panel returns.

import type { compose, metrics, nodes, OpOutput, projects, services, templates, updates } from "@seylo/ops";

export type Project = OpOutput<typeof projects.get>;
export type ServiceSummary = OpOutput<typeof services.list>["services"][number];
export type ServiceStatus = ServiceSummary["status"];
export type ServiceKind = ServiceSummary["kind"];
export type NodeRow = OpOutput<typeof nodes.list>["nodes"][number];
export type NodeDetail = OpOutput<typeof nodes.get>;
export type HealthReport = OpOutput<typeof nodes.healthReport>;
export type NodeSeries = OpOutput<typeof metrics.nodes>["nodes"][number];
export type MetricsRange = OpOutput<typeof metrics.nodes>["range"];
export type UpdateStatus = OpOutput<typeof updates.status>;
export type ComposePreview = OpOutput<typeof compose.preview>;
export type TemplateSummary = OpOutput<typeof templates.list>["templates"][number];
export type TemplateDetail = OpOutput<typeof templates.get>;
export type FormField = TemplateDetail["fields"][number];
export type FormValue = string | number | boolean;
