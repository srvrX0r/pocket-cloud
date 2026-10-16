import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/api";
import worker from "./index";
import { runMaintenance } from "./toolkit";

afterEach(() => vi.restoreAllMocks());

const SMALL = "d".repeat(64);
const REMOVED = "c".repeat(64);

/** A healthy ROM, an interrupted upload (too small) and a removal marker. */
async function seed(playerId: string): Promise<void> {
  const rom = new Uint8Array(4096);
  await env.ROMS.put(`roms/${playerId}/${await sha256Hex(rom)}`, rom);
  await env.ROMS.put(`roms/${playerId}/${SMALL}`, new Uint8Array(16));
  await env.ROMS.put(`removed/${playerId}/${REMOVED}`, new Uint8Array(0));
}

function reportFrom(log: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"maintenance"'));
  return JSON.parse(line!);
}

describe("runMaintenance", () => {
  it("reports the library but deletes nothing by default", async () => {
    const player = `player-${crypto.randomUUID()}`;
    await seed(player);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMaintenance(env);

    const report = reportFrom(log);
    expect(report).toMatchObject({ message: "maintenance", apply: false, deletedSuspects: 0 });
    expect((report.players as { playerId: string }[]).find((p) => p.playerId === player)).toMatchObject({
      roms: 2,
      removed: 1,
    });
    expect((report.suspectObjects as { key: string }[]).some((s) => s.key === `roms/${player}/${SMALL}`)).toBe(true);
    expect(await env.ROMS.head(`roms/${player}/${SMALL}`)).not.toBeNull();
  });

  it("deletes interrupted uploads when MAINTENANCE_APPLY is 1", async () => {
    const player = `player-${crypto.randomUUID()}`;
    await seed(player);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMaintenance({ ROMS: env.ROMS, MAINTENANCE_APPLY: "1" } as unknown as Env);

    const report = reportFrom(log);
    expect(report.apply).toBe(true);
    expect(report.deletedSuspects).toBeGreaterThanOrEqual(1);
    expect(await env.ROMS.head(`roms/${player}/${SMALL}`)).toBeNull();
  });

  it("runs the pass from the scheduled handler", async () => {
    const player = `player-${crypto.randomUUID()}`;
    await seed(player);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();

    await worker.scheduled(
      createScheduledController({ scheduledTime: new Date(), cron: "17 4 * * *" }),
      { ROMS: env.ROMS, MAINTENANCE_APPLY: "1" } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(await env.ROMS.head(`roms/${player}/${SMALL}`)).toBeNull();
  });
});
