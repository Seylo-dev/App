// What CodeEditor reported through onChange and the parent has not handed
// back as its value yet. React renders after the model has moved on: while
// someone types fast, the value prop of a render can be an older text the
// editor itself reported ("THI" while the model holds "THIRD=3"). Taking
// that for a reload replaced the text and lost the keys typed since. A
// value the editor reported is an echo, never a reload.

/** How many reported texts are kept; typing faster than React renders this many times does not happen. */
const keep = 200;

export class EchoTracker {
  private sent: string[] = [];

  /** The editor reported this text through onChange. */
  emitted(value: string): void {
    this.sent.push(value);
    if (this.sent.length > keep) this.sent.shift();
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
