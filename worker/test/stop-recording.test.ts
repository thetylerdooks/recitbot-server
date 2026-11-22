// stop_recording without recording_id: stops the account's one active recording; NO_ACTIVE_RECORDING when none is,
// MULTIPLE_ACTIVE_RECORDINGS (with the list) when several devices are recording.
import { describe, expect, it } from "vitest";
import { call, connectDevice, mcp, seedAccount, seedDevice, seedReady } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("timed out");
}

describe("stop_recording without recording_id", () => {
  it("no recording in progress: NO_ACTIVE_RECORDING", async () => {
    const acct = await seedAccount();
    const r = await mcp("stop_recording", {}, acct.key);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("NO_ACTIVE_RECORDING");
    expect(r.data.message).toMatch(/nothing to stop/);
  });

  it("one recording in progress: stops it on its device", async () => {
    const acct = await seedAccount();
    const d = await connectDevice(acct.deviceToken!);
    const start = await mcp("start_recording", { max_seconds: 10 }, acct.key);
    expect(start.isError).toBe(false);
    // A finished one on the account does not count.
    await seedReady(acct.accountId);
    const r = await mcp("stop_recording", {}, acct.key);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ recording_id: start.data.recording_id, status: "stopping" });
    await waitFor(() => d.frames.some((f) => f.type === "stop"));
    expect(d.frames.find((f) => f.type === "stop").recording_id).toBe(start.data.recording_id);
    d.ws.close();
  });

  it("recordings on two devices: MULTIPLE_ACTIVE_RECORDINGS lists them and nothing is stopped; recording_id still works", async () => {
    const acct = await seedAccount();
    const laptop = await seedDevice(acct.accountId, "Laptop");
    const desk = await connectDevice(acct.deviceToken!);
    await sleep(20);
    const lap = await connectDevice(laptop.token);
    const r1 = await mcp("start_recording", { max_seconds: 10, device: laptop.deviceId }, acct.key);
    const r2 = await mcp("start_recording", { max_seconds: 10, device: acct.deviceId }, acct.key);
    expect([r1.isError, r2.isError]).toEqual([false, false]);

    const r = await mcp("stop_recording", {}, acct.key);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("MULTIPLE_ACTIVE_RECORDINGS");
    expect(r.data.message).toMatch(/call stop_recording again with its recording_id/);
    expect(r.data.active).toHaveLength(2);
    expect(r.data.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recording_id: r1.data.recording_id, device: laptop.deviceId, device_name: "Laptop" }),
        expect.objectContaining({ recording_id: r2.data.recording_id, device: acct.deviceId, device_name: "test pc" }),
      ]),
    );
    await sleep(20);
    expect([...desk.frames, ...lap.frames].some((f) => f.type === "stop")).toBe(false);

    const one = await mcp("stop_recording", { recording_id: r1.data.recording_id }, acct.key);
    expect(one.data.status).toBe("stopping");
    await waitFor(() => lap.frames.some((f) => f.type === "stop"));
    desk.ws.close();
    lap.ws.close();
  });

  it("another account's recording is not stopped", async () => {
    const other = await seedAccount();
    const d = await connectDevice(other.deviceToken!);
    expect((await mcp("start_recording", { max_seconds: 10 }, other.key)).isError).toBe(false);
    const mine = await seedAccount();
    expect((await mcp("stop_recording", {}, mine.key)).data.error).toBe("NO_ACTIVE_RECORDING");
    await sleep(20);
    expect(d.frames.some((f) => f.type === "stop")).toBe(false);
    d.ws.close();
  });

  it("tools/list: recording_id is optional and the description names both errors", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const tools = ((await res.json()) as any).result.tools as { name: string; description: string; inputSchema: any }[];
    const t = tools.find((x) => x.name === "stop_recording")!;
    expect(t.inputSchema.required ?? []).not.toContain("recording_id");
    expect(t.inputSchema.properties.recording_id).toBeDefined();
    expect(t.description).toMatch(/NO_ACTIVE_RECORDING/);
    expect(t.description).toMatch(/MULTIPLE_ACTIVE_RECORDINGS/);
  });
});
