// String formats used in op schemas. TypeBox only validates formats that
// are registered, and an unregistered one fails every value, so each
// format an op uses must be listed here. Imported for its side effect by
// index.ts, which means every consumer of @seylo/ops gets them.

import { FormatRegistry } from "@sinclair/typebox";

// Deliberately loose: the real check for an email is sending to it.
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const formats: Record<string, (value: string) => boolean> = {
  email: (value) => email.test(value),
  "date-time": (value) => dateTime.test(value) && !Number.isNaN(Date.parse(value)),
};

for (const [name, check] of Object.entries(formats)) {
  if (!FormatRegistry.Has(name)) FormatRegistry.Set(name, check);
}

export const registeredFormats = Object.keys(formats);
