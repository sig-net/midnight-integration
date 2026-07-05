// Errors shared by the CLI commands.

/**
 * Thrown by command stubs at the boundary where the runtime plumbing or the
 * contract circuit they need does not exist yet. The message names the
 * missing piece so a failing run says exactly what to build next.
 */
export class NotImplementedError extends Error {
  /**
   * @param message - What is missing and where it is expected to live.
   */
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
