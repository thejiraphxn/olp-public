/**
 * Make BigInt values JSON-serializable by converting them to strings.
 * Prisma returns BigInt for columns typed `BigInt` (e.g. SessionRecording.sizeBytes)
 * but Node's JSON.stringify throws "Do not know how to serialize a BigInt".
 *
 * Import this once from the process entry points (server.ts, worker.ts) before
 * any response serialization happens.
 */
if (!(BigInt.prototype as any).toJSON) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () {
      return this.toString();
    },
    writable: true,
    configurable: true,
  });
}

export {};
