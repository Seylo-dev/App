// What CodeEditor reported through onChange and the parent has not handed
// back as its value yet. React renders after the model has moved on: while
// someone types fast, the value prop of a render can be an older text the
// editor itself reported ("THI" while the model holds "THIRD=3"). Taking
// that for a reload replaced the text and lost the keys typed since. A
// value the editor reported is an echo, never a reload. A reload itself
// reports its text too (the edit fires the change event): that is no
// echo, and once it is in the editor nothing reported before is one.

/** How many reported texts are kept; typing faster than React renders this many times does not happen. */
const keep = 200;

export class EchoTracker {
  private sent: string[] = [];
  private reloading = false;

  /** The editor reported this text through onChange; ignored while a reload replaces the text. */
  emitted(value: string): void {
    if (this.reloading) return;
    this.sent.push(value);
    if (this.sent.length > keep) this.sent.shift();
  }

  /**
   * Runs apply, which puts a reload into the editor. What it reports
   * meanwhile is not recorded, and what was reported before is forgotten:
   * the parent's text is the reload now, so a later value equal to an
   * older text (someone reverted) is a reload too.
   */
  reload(apply: () => void): void {
    this.reloading = true;
    try {
      apply();
    } finally {
      this.reloading = false;
      this.sent = [];
    }
  }

  /**
   * Whether a value prop is one the editor reported (an echo, maybe an old
   * one); it and everything reported before it are forgotten, so a later
   * reload to the same text still applies.
   */
  isEcho(value: string): boolean {
    const i = this.sent.lastIndexOf(value);
    if (i === -1) return false;
    this.sent.splice(0, i + 1);
    return true;
  }
}
