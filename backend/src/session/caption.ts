/**
 * Rolling live caption built from transcript fragments. Kept in memory only.
 * A segment ends when the engine marks it finished or after a pause; the next fragment starts fresh.
 */
export class RollingCaption {
  text = ''
  private closed = false
  private lastAt = 0

  constructor(
    private readonly maxChars = 240,
    private readonly gapMs = 2500,
  ) {}

  add(fragment: string, finished: boolean | undefined, at: number): string {
    if (this.closed || (this.text && at - this.lastAt > this.gapMs)) {
      this.text = ''
      this.closed = false
    }
    this.text += fragment
    this.lastAt = at
    if (this.text.length > this.maxChars) {
      const cut = this.text.slice(-this.maxChars)
      const space = cut.indexOf(' ')
      this.text = space > 0 ? cut.slice(space + 1) : cut
    }
    if (finished) this.closed = true
    return this.text.trimStart()
  }

  get current(): string {
    return this.text.trimStart()
  }

  reset(): void {
    this.text = ''
    this.closed = false
  }
}
