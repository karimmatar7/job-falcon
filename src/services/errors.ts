/** Thrown by placeholder services that will be implemented in a later phase. */
export class ServiceNotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet (planned for a later phase).`);
    this.name = "ServiceNotImplementedError";
  }
}
