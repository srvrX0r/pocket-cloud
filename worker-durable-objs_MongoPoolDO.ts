// src/worker/durable-objects/MongoPoolDO.ts
import { MongoClient } from "mongodb";

export class MongoPoolDO extends DurableObject {
  private client: MongoClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx);
    this.client = new MongoClient(env.MONGODB_URI, {
      maxPoolSize: 5,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
      maxIdleTimeMS: 30000,
    });
    ctx.blockConcurrencyWhile(async () => {
      await this.client.connect();
    });
  }

  // Expose query methods via RPC
  async findScenarios(playerId: string, romId: string) {
    const db = this.client.db("pocket-cloud");
    return db.collection("Scenario")
      .find({ playerId, romId })
      .toArray();
  }

  async insertSnapshot(doc: object) {
    const db = this.client.db("pocket-cloud");
    return db.collection("Snapshot").insertOne(doc);
  }
}

// wrangler.jsonc (add)
{
  "durable_objects": {
    "bindings": [
      { "name": "PLAYER_SAVE", "class_name": "PlayerSaveDO" },
      { "name": "MONGO_POOL",  "class_name": "MongoPoolDO", "location_hint": "us-east" }
    ]
  }
}

Snapshot Capture Loop (Worker Cron + DO Alarm)
// Inside PlayerSaveDO — triggered by a DO alarm every N minutes
async takeSnapshot(romHash: string, slot: number) {
  const sram = this.db.prepare(
    "SELECT sram FROM saves WHERE rom_hash = ?"
  ).get(romHash);
  if (!sram) return;

  const hash = sha256(sram);
  const key = `snapshots/${this.playerId}/${romHash}/slot${slot}/${Date.now()}.bin`;

  // 1. Upload binary to R2
  await this.env.SNAPSHOTS.put(key, sram);

  // 2. Index in MongoDB via MongoPoolDO
  const mongo = this.ctx.storage.get("mongoRef"); // RPC stub
  await mongo.insertSnapshot({
    scenarioId: this.getScenarioId(romHash, slot),
    r2Key: key,
    sramHash: hash,
    sramSize: sram.byteLength,
    intervalMin: this.slotInterval(slot), // 30, 60, 90, or 120
  });

  // 3. Schedule next alarm
  const nextMs = this.slotInterval(slot) * 60 * 1000;
  this.ctx.storage.setAlarm(Date.now() + nextMs);
}
