// The dashboard's title: a greeting for the time of day on this device,
// with the person's first name when the account has one.

import { t } from "../i18n/t";

export type DayPart = "morning" | "afternoon" | "evening" | "night";

/** 05-11 morning, 12-16 afternoon, 17-21 evening, 22-04 night. */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/** "Amir" from "Amir Eliz"; null without a name (an email is not a name). */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

export function greeting(name: string | null | undefined, now = new Date()): string {
  const part = dayPart(now.getHours());
  const first = firstName(name);
  return first ? t(`dashboard.greeting.${part}`, { name: first }) : t(`dashboard.greetingNoName.${part}`);
}
