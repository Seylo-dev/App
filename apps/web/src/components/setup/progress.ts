// Where the setup wizard is, kept in sessionStorage so a reload (or the
// GitHub device-flow tab coming back) resumes at the same step with the
// same skipped list. Per tab and best effort: storage can be missing or
// throw (private mode), and then the wizard starts after the owner step.

export interface SetupProgress {
  step: string;
  skipped: string[];
}

const key = "setup-progress";

/** The saved progress when its step is one of `steps` (never the owner step), else null. */
export function parseProgress(raw: string | null, steps: readonly string[]): SetupProgress | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SetupProgress>;
    if (typeof value.step !== "string" || value.step === "owner" || !steps.includes(value.step)) return null;
    const skipped = Array.isArray(value.skipped)
      ? value.skipped.filter((s): s is string => typeof s === "string" && steps.includes(s))
      : [];
    return { step: value.step, skipped };
  } catch {
    return null;
  }
}

export function loadProgress(steps: readonly string[]): SetupProgress | null {
  try {
    return parseProgress(window.sessionStorage.getItem(key), steps);
  } catch {
    return null;
  }
}

export function saveProgress(progress: SetupProgress | null): void {
  try {
    if (progress) window.sessionStorage.setItem(key, JSON.stringify(progress));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Not kept: a reload starts after the owner step.
  }
}
