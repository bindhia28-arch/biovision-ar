import type { ScanRecord, SecureStore, SyncEnvelope } from "../core/types.js";

const QUEUE_KEY = "biovision.sync.queue";

export class OfflineScanManager {
  public constructor(private readonly store: SecureStore) {}

  public async enqueueScan(scan: ScanRecord): Promise<void> {
    const queue = await this.readQueue();
    queue.push({
      id: scan.id,
      createdAt: new Date().toISOString(),
      kind: "scan-metrics",
      payload: { scanId: scan.id, metrics: scan.metrics, joints: scan.joints }
    });
    await this.writeQueue(queue);
  }

  public async flush(send: (item: SyncEnvelope) => Promise<void>): Promise<number> {
    const queue = await this.readQueue();
    let sent = 0;
    for (const item of queue) {
      await send(item);
      sent += 1;
    }
    await this.writeQueue(queue.slice(sent));
    return sent;
  }

  private async readQueue(): Promise<SyncEnvelope[]> {
    const bytes = await this.store.get(QUEUE_KEY);
    if (!bytes) return [];
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed)) throw new Error("Encrypted sync queue is malformed");
    return parsed as SyncEnvelope[];
  }

  private writeQueue(queue: readonly SyncEnvelope[]): Promise<void> {
    return this.store.put(QUEUE_KEY, new TextEncoder().encode(JSON.stringify(queue)));
  }
}
