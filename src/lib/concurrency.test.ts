/**
 * 受控并发工具单测
 *
 * 三条保证逐条钉住：**顺序一致**、**上限生效**、**失败即停**。
 * 这三条里任何一条写错，索引流水线都会以一种很难排查的方式坏掉：
 * 顺序错会让切片与 chunkIndex 错位（引用展示的内容与实际不符），
 * 上限失效会让第一次真实索引就撞限流，失败不停会让一次错误放大成几十次调用。
 */

import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./concurrency";

/** 让出事件循环一轮，用于模拟真实的异步等待 */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("空数组不启动任何任务", async () => {
    let calls = 0;
    const result = await mapWithConcurrency([], 3, async () => {
      calls += 1;
      return 0;
    });

    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("结果顺序与输入一致（与完成先后无关）", async () => {
    // 第 3 项最先完成、第 1 项最后完成 —— 若按完成顺序收集，结果会反过来
    const delays = [30, 20, 0, 10];
    const result = await mapWithConcurrency([0, 1, 2, 3], 4, async (item) => {
      await tick(delays[item] ?? 0);
      return `item-${item}`;
    });

    expect(result).toEqual(["item-0", "item-1", "item-2", "item-3"]);
  });

  it("任意时刻进行中的任务数不超过上限", async () => {
    const limit = 3;
    const items = Array.from({ length: 11 }, (_, index) => index);
    let active = 0;
    let maxActive = 0;

    await mapWithConcurrency(items, limit, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(5);
      active -= 1;
      return item;
    });

    expect(maxActive).toBeLessThanOrEqual(limit);
    // 反证：上限真的被用满了，而不是退化成串行 —— 否则这个断言恒真
    expect(maxActive).toBe(limit);
  });

  it("上限大于任务数时，并发数等于任务数", async () => {
    let active = 0;
    let maxActive = 0;

    await mapWithConcurrency([1, 2], 8, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(5);
      active -= 1;
      return item;
    });

    expect(maxActive).toBe(2);
  });

  it("上限小于 1 时夹取为 1（而不是静默返回空结果）", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrency([1, 2, 3], 0, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(2);
      active -= 1;
      return item;
    });

    expect(result).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });

  it("worker 拿到的是输入项在**原数组**中的下标", async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(["a", "b", "c"], 2, async (item, index) => {
      seen.push([item, index]);
      return index;
    });

    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("失败后不再派发新任务，且原样抛出该错误", async () => {
    const failure = new Error("第 2 项失败");
    const started: number[] = [];

    await expect(
      mapWithConcurrency(
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        2,
        async (item) => {
          started.push(item);
          if (item === 1) {
            throw failure;
          }
          await tick(1);
          return item;
        },
      ),
    ).rejects.toBe(failure);

    // 并发 2、第 1 项就抛错 → 最多再让一个「已经领走」的任务跑完（第 0 项），
    // 其余 8 项必须一次都没有被启动
    expect(started.length).toBeLessThanOrEqual(3);
    expect(started).not.toContain(5);
    expect(started).not.toContain(9);
  });

  it("全部成功时才返回结果数组", async () => {
    const result = await mapWithConcurrency([2, 4, 6], 2, async (item) => item * 10);
    expect(result).toEqual([20, 40, 60]);
  });
});
