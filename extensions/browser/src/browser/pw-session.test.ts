// Browser tests cover pw session plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  beginActionDownloadCaptureOnPage,
  ensurePageState,
  isDownloadStartingNavigationError,
  refLocator,
  rememberRoleRefsForTarget,
  restoreRoleRefsForTarget,
  storeRoleRefsForTarget,
} from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";

type MutableDownload = {
  url?: () => string;
  suggestedFilename: () => string;
  saveAs: ReturnType<typeof vi.fn>;
  path?: () => Promise<string>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

function fakePage(): {
  page: Page;
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  mainFrame: { url: () => string };
  mocks: {
    on: ReturnType<typeof vi.fn>;
    getByRole: ReturnType<typeof vi.fn>;
    frameLocator: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
  };
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return undefined as unknown;
  });
  const off = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    handlers.set(
      event,
      list.filter((handler) => handler !== cb),
    );
    return undefined as unknown;
  });
  const getByRole = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));
  const frameLocator = vi.fn(() => ({
    getByRole: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
    locator: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
  }));
  const locator = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));

  const mainFrame = { url: () => "https://test.example.com" };
  const page = {
    on,
    off,
    getByRole,
    frameLocator,
    locator,
    mainFrame: () => mainFrame,
  } as unknown as Page;

  return { page, handlers, mainFrame, mocks: { on, getByRole, frameLocator, locator } };
}

function firstSavePath(saveAs: MutableDownload["saveAs"]): string {
  const [call] = saveAs.mock.calls;
  if (!call) {
    throw new Error("Expected saveAs call");
  }
  const [savedPath] = call;
  if (typeof savedPath !== "string") {
    throw new Error("Expected saved download path");
  }
  return savedPath;
}

describe("pw-session refLocator", () => {
  it("uses frameLocator for role refs when snapshot was scoped to a frame", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { e1: { role: "button", name: "OK" } };
    state.roleRefsFrameSelector = "iframe#main";

    refLocator(page, "e1");

    expect(mocks.frameLocator).toHaveBeenCalledWith("iframe#main");
  });

  it("uses page getByRole for role refs by default", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { e1: { role: "button", name: "OK" } };

    refLocator(page, "e1");

    expect(mocks.getByRole).toHaveBeenCalled();
  });

  it("uses aria-ref locators when refs mode is aria", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefsMode = "aria";

    refLocator(page, "e1");

    expect(mocks.locator).toHaveBeenCalledWith("aria-ref=e1");
  });

  it("uses backend-marked DOM locators for ax refs", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { ax12: { role: "button", name: "OK", domMarker: true } };

    refLocator(page, "ax12");

    expect(mocks.locator).toHaveBeenCalledWith(`[${BROWSER_REF_MARKER_ATTRIBUTE}="ax12"]`);
  });

  it("falls back to role heuristics for ax refs without backend markers", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { ax12: { role: "button", name: "OK" } };

    refLocator(page, "ax12");

    expect(mocks.getByRole).toHaveBeenCalledWith("button", { name: "OK", exact: true });
  });

  it("rejects unknown ax refs instead of timing out on aria-ref locators", () => {
    const { page, mocks } = fakePage();

    expect(() => refLocator(page, "ax12")).toThrow(/Unknown ref/);
    expect(mocks.locator).not.toHaveBeenCalled();
  });
});

describe("pw-session role refs cache", () => {
  it("restores refs for a different Page instance (same CDP targetId)", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    rememberRoleRefsForTarget({
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "OK" } },
      frameSelector: "iframe#main",
      navGen: 0,
    });

    const { page, mocks } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page });

    refLocator(page, "e1");
    expect(mocks.frameLocator).toHaveBeenCalledWith("iframe#main");
  });

  it("blocks restore after navigation (target-scoped navGen)", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    const { page, handlers, mainFrame } = fakePage();
    // Snapshot stores refs at target gen 0
    storeRoleRefsForTarget({
      page,
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "OK" } },
      mode: "role",
    });

    // Navigate clears refs and bumps target gen to 1
    handlers.get("framenavigated")?.[0]?.(mainFrame);
    expect(ensurePageState(page).roleRefs).toBeUndefined();

    // Restore must reject cached gen-0 refs (target is now at gen 1)
    restoreRoleRefsForTarget({ cdpUrl, targetId, page });
    expect(ensurePageState(page).roleRefs).toBeUndefined();
  });

  it("allows restore for a replacement Page when target gen matches", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    // Page A: snapshot stores refs at target gen 0
    const { page: pageA } = fakePage();
    storeRoleRefsForTarget({
      page: pageA,
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "OK" } },
      mode: "role",
    });

    // Page B (replacement, same target): restore must succeed (both gen 0)
    const { page: pageB, mocks } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page: pageB });
    expect(ensurePageState(pageB).roleRefs).toBeDefined();

    // Verify refLocator works with restored refs
    refLocator(pageB, "e1");
    expect(mocks.getByRole).toHaveBeenCalled();
  });

  it("rejects stale cached refs for a replacement Page after target navigation", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    // Page A: snapshot stores refs at target gen 0
    const { page: pageA, handlers, mainFrame } = fakePage();
    storeRoleRefsForTarget({
      page: pageA,
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "PageA-Btn" } },
      mode: "role",
    });

    // Navigate on Page A → target gen becomes 1, refs cleared
    handlers.get("framenavigated")?.[0]?.(mainFrame);
    expect(ensurePageState(pageA).roleRefs).toBeUndefined();

    // Page B (replacement, same target): restore must reject stale gen-0 cache
    const { page: pageB } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page: pageB });
    expect(ensurePageState(pageB).roleRefs).toBeUndefined();
  });

  it("restores fresh post-navigation cache for a replacement Page", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    // Page A: navigate, then snapshot on the new page caches at target gen 1
    const { page: pageA, handlers, mainFrame } = fakePage();
    handlers.get("framenavigated")?.[0]?.(mainFrame); // target gen → 1

    storeRoleRefsForTarget({
      page: pageA,
      cdpUrl,
      targetId,
      refs: { e1: { role: "heading", name: "PageB-Title" } },
      mode: "aria",
    });

    // Page B (replacement): restore must succeed (both gen 1)
    const { page: pageB } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page: pageB });
    expect(ensurePageState(pageB).roleRefs).toBeDefined();
    expect(ensurePageState(pageB).roleRefs!.e1.name).toBe("PageB-Title");
  });

  it("evicts target generation alongside role-ref cache eviction", () => {
    const cdpUrl = "http://127.0.0.1:9222";

    // Bump generation for a target by navigating
    const { page: pageA, handlers, mainFrame } = fakePage();
    storeRoleRefsForTarget({
      page: pageA,
      cdpUrl,
      targetId: "keeper",
      refs: { e1: { role: "button", name: "Keeper" } },
      mode: "role",
    });
    handlers.get("framenavigated")?.[0]?.(mainFrame); // target gen → 1

    // Fill the cache past MAX_ROLE_REFS_CACHE (50) to evict the oldest entry
    // Each storeRoleRefsForTarget call adds one entry via rememberRoleRefsForTarget
    for (let i = 0; i < 55; i++) {
      const { page: filler } = fakePage();
      storeRoleRefsForTarget({
        page: filler,
        cdpUrl,
        targetId: `filler-${i}`,
        refs: { e1: { role: "button", name: `F${i}` } },
        mode: "role",
      });
    }

    // The "keeper" entry should have been evicted (it was first in)
    // After eviction, a new restore for "keeper" should see gen 0 (default)
    const { page: pageB } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId: "keeper", page: pageB });
    // Evicted → cache miss → restore is a no-op
    expect(ensurePageState(pageB).roleRefs).toBeUndefined();
  });
});

describe("pw-session ensurePageState", () => {
  it("stores unmanaged downloads under unique managed paths", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);

    const saveAsA = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-a", "utf8");
    });
    const saveAsB = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-b", "utf8");
    });
    const downloadA: MutableDownload = {
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsA,
    };
    const downloadB: MutableDownload = {
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsB,
    };

    handlers.get("download")?.[0]?.(downloadA);
    handlers.get("download")?.[0]?.(downloadB);

    const managedPathA = await downloadA.path?.();
    const managedPathB = await downloadB.path?.();

    expect(managedPathA).not.toBe(managedPathB);
    expect(path.dirname(managedPathA ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.dirname(managedPathB ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.basename(managedPathA ?? "")).toMatch(/-report\.pdf$/);
    expect(path.basename(managedPathB ?? "")).toMatch(/-report\.pdf$/);
    const savedPathA = firstSavePath(saveAsA);
    const savedPathB = firstSavePath(saveAsB);
    expect(savedPathA).not.toBe(managedPathA);
    expect(savedPathB).not.toBe(managedPathB);
    for (const savedPath of [savedPathA, savedPathB]) {
      expect(savedPath.length).toBeGreaterThan(0);
      const savedParentName = path.basename(path.dirname(savedPath));
      expect(
        savedParentName.includes("fs-safe-output") ||
          savedParentName === path.basename(DEFAULT_DOWNLOAD_DIR),
      ).toBe(true);
    }
    await expect(fs.readFile(managedPathA ?? "", "utf8")).resolves.toBe("download-a");
    await expect(fs.readFile(managedPathB ?? "", "utf8")).resolves.toBe("download-b");
  });

  it("suppresses unmanaged download save rejections until path is awaited", async () => {
    const { page, handlers } = fakePage();
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    ensurePageState(page);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const err = new Error("save failed");
    const download: MutableDownload = {
      suggestedFilename: () => "report.pdf",
      saveAs: vi.fn(async () => {
        throw err;
      }),
    };

    try {
      handlers.get("download")?.[0]?.(download);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandled).toStrictEqual([]);
      await expect(download.path?.()).rejects.toThrow("save failed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("leaves unmanaged download handling to explicit waiters while armed", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    state.downloadWaiterDepth = 1;
    const download = {
      suggestedFilename: () => "report.pdf",
      saveAs: vi.fn(async () => {}),
    };

    handlers.get("download")?.[0]?.(download);

    expect(download).not.toHaveProperty("path");
    expect(download.saveAs).not.toHaveBeenCalled();
  });

  it("reports all downloads owned by the active action with managed metadata", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);
    const firstSave = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "first-action-download", "utf8");
    });
    const secondSave = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "second-action-download", "utf8");
    });

    for (const download of [
      {
        url: () => "https://example.com/first.txt",
        suggestedFilename: () => "first.txt",
        saveAs: firstSave,
      },
      {
        url: () => "https://example.com/second.txt",
        suggestedFilename: () => "second.txt",
        saveAs: secondSave,
      },
    ]) {
      handlers.get("download")?.[0]?.(download);
    }

    const result = await capture.drain();
    capture.dispose();

    expect(result).toEqual([
      {
        url: "https://example.com/first.txt",
        suggestedFilename: "first.txt",
        path: expect.stringMatching(/-first\.txt$/),
      },
      {
        url: "https://example.com/second.txt",
        suggestedFilename: "second.txt",
        path: expect.stringMatching(/-second\.txt$/),
      },
    ]);
    await expect(fs.readFile(result?.[0]?.path ?? "", "utf8")).resolves.toBe(
      "first-action-download",
    );
    await expect(fs.readFile(result?.[1]?.path ?? "", "utf8")).resolves.toBe(
      "second-action-download",
    );
  });

  it("waits only the requested first-event grace for a just-late action download", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "late-action-download", "utf8");
    });
    const drain = capture.drain({ firstEventGraceMs: 1_000 });

    setImmediate(() => {
      handlers.get("download")?.[0]?.({
        url: () => "https://example.com/late.txt",
        suggestedFilename: () => "late.txt",
        saveAs,
      });
    });

    await expect(drain).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "late.txt" }),
    ]);
    capture.dispose();
  });

  it("keeps a quiet window open for sibling downloads after the first event", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);
    const save = (contents: string) =>
      vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, contents, "utf8");
      });

    handlers.get("download")?.[0]?.({
      url: () => "https://example.com/first.txt",
      suggestedFilename: () => "first.txt",
      saveAs: save("first"),
    });
    setImmediate(() => {
      handlers.get("download")?.[0]?.({
        url: () => "https://example.com/second.txt",
        suggestedFilename: () => "second.txt",
        saveAs: save("second"),
      });
    });

    await expect(capture.drain({ quietMs: 1_000 })).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "first.txt" }),
      expect.objectContaining({ suggestedFilename: "second.txt" }),
    ]);
    capture.dispose();
  });

  it("detaches ownership before waiting for slow file saves", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const beforeSave = vi.fn(async () => {});
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    const firstSave = vi.fn(async (outPath: string) => {
      await firstSaveGate;
      await fs.writeFile(outPath, "first", "utf8");
    });
    handlers.get("download")?.[0]?.({
      url: () => "https://example.com/first.txt",
      suggestedFilename: () => "first.txt",
      saveAs: firstSave,
    });

    const drain = capture.drain();
    const lateSave = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "late", "utf8");
    });
    const lateDownload: MutableDownload = {
      url: () => "https://example.com/late.txt",
      suggestedFilename: () => "late.txt",
      saveAs: lateSave,
    };
    handlers.get("download")?.[0]?.(lateDownload);
    releaseFirstSave?.();

    await expect(drain).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "first.txt" }),
    ]);
    await expect(lateDownload.path?.()).resolves.toMatch(/-late\.txt$/);
    expect(beforeSave).toHaveBeenCalledOnce();
    expect(lateSave).toHaveBeenCalledOnce();
    capture.dispose();
  });

  it("keeps started saves with their owner and assigns future downloads to the latest action", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const first = beginActionDownloadCaptureOnPage(page);
    const firstSaveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "first-action-download", "utf8");
    });
    handlers.get("download")?.[0]?.({
      url: () => "https://example.com/first.txt",
      suggestedFilename: () => "first.txt",
      saveAs: firstSaveAs,
    });

    const latest = beginActionDownloadCaptureOnPage(page);
    first.dispose();
    const latestSaveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "latest-action-download", "utf8");
    });
    handlers.get("download")?.[0]?.({
      url: () => "https://example.com/latest.txt",
      suggestedFilename: () => "latest.txt",
      saveAs: latestSaveAs,
    });

    await expect(first.drain()).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "first.txt" }),
    ]);
    await expect(latest.drain()).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "latest.txt" }),
    ]);
    latest.dispose();
    expect(firstSaveAs).toHaveBeenCalledOnce();
    expect(latestSaveAs).toHaveBeenCalledOnce();
  });

  it("leaves action capture empty while an explicit download owner is armed", async () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    state.downloadWaiterDepth = 1;
    const capture = beginActionDownloadCaptureOnPage(page);
    const download = {
      suggestedFilename: () => "explicit.txt",
      saveAs: vi.fn(async () => {}),
    };

    handlers.get("download")?.[0]?.(download);

    await expect(capture.drain()).resolves.toBeUndefined();
    capture.dispose();
    expect(download).not.toHaveProperty("path");
    expect(download.saveAs).not.toHaveBeenCalled();
  });

  it("validates action-owned download URLs before saving bytes", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const blocked = new Error("blocked action download");
    const beforeSave = vi.fn(async () => {
      throw blocked;
    });
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "blocked-action-download", "utf8");
    });

    handlers.get("download")?.[0]?.({
      url: () => "http://127.0.0.1/private.txt",
      suggestedFilename: () => "private.txt",
      saveAs,
    });

    await expect(capture.drain()).rejects.toBe(blocked);
    capture.dispose();
    expect(beforeSave).toHaveBeenCalledWith({
      url: "http://127.0.0.1/private.txt",
      suggestedFilename: "private.txt",
    });
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("drains late siblings before surfacing the first download policy failure", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const blocked = new Error("blocked action download");
    const beforeSave = vi.fn(async () => {
      throw blocked;
    });
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    const firstSave = vi.fn(async () => {});
    const secondSave = vi.fn(async () => {});

    handlers.get("download")?.[0]?.({
      url: () => "http://127.0.0.1/first.txt",
      suggestedFilename: () => "first.txt",
      saveAs: firstSave,
    });
    setImmediate(() => {
      handlers.get("download")?.[0]?.({
        url: () => "http://127.0.0.1/second.txt",
        suggestedFilename: () => "second.txt",
        saveAs: secondSave,
      });
    });

    await expect(capture.drain({ quietMs: 1_000 })).rejects.toBe(blocked);
    capture.dispose();
    expect(beforeSave).toHaveBeenCalledTimes(2);
    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).not.toHaveBeenCalled();
  });

  it("surfaces a sibling policy denial without waiting for an allowed slow save", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const blocked = new Error("blocked sibling download");
    const beforeSave = vi.fn(async (candidate: { url: string }) => {
      if (candidate.url.endsWith("/blocked.txt")) {
        throw blocked;
      }
    });
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    let releaseAllowedSave: (() => void) | undefined;
    const allowedSaveGate = new Promise<void>((resolve) => {
      releaseAllowedSave = resolve;
    });
    const allowedDownload: MutableDownload = {
      url: () => "https://example.com/allowed.txt",
      suggestedFilename: () => "allowed.txt",
      saveAs: vi.fn(async (outPath: string) => {
        await allowedSaveGate;
        await fs.writeFile(outPath, "allowed", "utf8");
      }),
    };
    handlers.get("download")?.[0]?.(allowedDownload);
    setImmediate(() => {
      handlers.get("download")?.[0]?.({
        url: () => "https://example.com/blocked.txt",
        suggestedFilename: () => "blocked.txt",
        saveAs: vi.fn(async () => {}),
      });
    });

    await expect(capture.drain({ quietMs: 100 })).rejects.toBe(blocked);
    releaseAllowedSave?.();
    await expect(allowedDownload.path?.()).resolves.toMatch(/-allowed\.txt$/);
    capture.dispose();
  });

  it("surfaces action-owned download save failures without an unhandled rejection", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);
    const error = new Error("action download save failed");

    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "failed.txt",
      saveAs: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(capture.drain()).rejects.toBe(error);
    capture.dispose();
  });

  it("captures navigation downloads under managed paths", async () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    const capture = createDownloadCaptureForPage(page, state, 1_000);
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "attachment", "utf8");
    });
    const download = {
      url: () => "https://example.com/export.csv",
      suggestedFilename: () => "export.csv",
      saveAs,
    };

    for (const handler of handlers.get("download") ?? []) {
      handler(download);
    }

    const result = await capture.promise;
    expect(result.url).toBe("https://example.com/export.csv");
    expect(result.suggestedFilename).toBe("export.csv");
    expect(path.dirname(result.path)).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.basename(result.path)).toMatch(/-export\.csv$/);
    expect(firstSavePath(saveAs)).not.toBe(result.path);
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("attachment");
  });

  it("validates captured navigation downloads before saving managed bytes", async () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    const blocked = new Error("blocked download");
    const beforeSave = vi.fn(async () => {
      throw blocked;
    });
    const capture = createDownloadCaptureForPage(page, state, 1_000, { beforeSave });
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "blocked", "utf8");
    });
    const download = {
      url: () => "http://127.0.0.1:18080/export.csv",
      suggestedFilename: () => "export.csv",
      saveAs,
    };

    for (const handler of handlers.get("download") ?? []) {
      handler(download);
    }

    await expect(capture.promise).rejects.toBe(blocked);
    expect(beforeSave).toHaveBeenCalledWith({
      url: "http://127.0.0.1:18080/export.csv",
      suggestedFilename: "export.csv",
    });
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("lets explicit download owners arm while passive capture yields", () => {
    const { page } = fakePage();
    const state = ensurePageState(page);
    state.downloadWaiterDepth = 1;

    const passive = createDownloadCaptureForPage(page, state, 1_000);
    const explicit = createDownloadCaptureForPage(page, state, 1_000, { mode: "explicit" });

    expect(passive.armed).toBe(false);
    expect(explicit.armed).toBe(true);
    expect(state.downloadWaiterDepth).toBe(2);
    explicit.cancel();
    expect(state.downloadWaiterDepth).toBe(1);
  });

  it("recognizes Playwright download-starting navigation aborts", () => {
    expect(isDownloadStartingNavigationError(new Error("page.goto: Download is starting"))).toBe(
      true,
    );
    expect(isDownloadStartingNavigationError(new Error("page.goto: net::ERR_ABORTED"))).toBe(false);
    expect(
      isDownloadStartingNavigationError(
        new Error("page.goto: net::ERR_ABORTED at http://127.0.0.1:3333/download"),
        "http://127.0.0.1:3333/download",
      ),
    ).toBe(true);
    expect(
      isDownloadStartingNavigationError(
        new Error("page.goto: net::ERR_ABORTED at http://127.0.0.1:3333/other"),
        "http://127.0.0.1:3333/download",
      ),
    ).toBe(false);
    expect(isDownloadStartingNavigationError(new Error("Navigation failed"))).toBe(false);
  });

  it("tracks page errors and network requests (best-effort)", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);

    const req = {
      method: () => "GET",
      url: () => "https://example.com/api",
      resourceType: () => "xhr",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    } as unknown as import("playwright-core").Request;

    const resp = {
      request: () => req,
      status: () => 500,
      ok: () => false,
    } as unknown as import("playwright-core").Response;

    handlers.get("request")?.[0]?.(req);
    handlers.get("response")?.[0]?.(resp);
    handlers.get("requestfailed")?.[0]?.(req);
    handlers.get("pageerror")?.[0]?.(new Error("boom"));

    expect(state.errors.at(-1)?.message).toBe("boom");
    const request = state.requests.at(-1);
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("https://example.com/api");
    expect(request?.resourceType).toBe("xhr");
    expect(request?.status).toBe(500);
    expect(request?.ok).toBe(false);
    expect(request?.failureText).toBe("net::ERR_FAILED");
  });

  it("drops state on page close", () => {
    const { page, handlers } = fakePage();
    const state1 = ensurePageState(page);
    handlers.get("close")?.[0]?.();

    const state2 = ensurePageState(page);
    expect(state2).not.toBe(state1);
    expect(state2.console).toStrictEqual([]);
    expect(state2.errors).toStrictEqual([]);
    expect(state2.requests).toStrictEqual([]);
  });

  it("clears role refs on main-frame navigation (role mode)", () => {
    const { page, handlers, mainFrame } = fakePage();
    const state = ensurePageState(page);

    storeRoleRefsForTarget({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "t1",
      refs: { e1: { role: "button", name: "OK" }, e2: { role: "link", name: "Home" } },
      mode: "role",
    });
    expect(state.roleRefs).toBeDefined();
    expect(Object.keys(state.roleRefs!)).toHaveLength(2);
    expect(state.roleRefsMode).toBe("role");

    handlers.get("framenavigated")?.[0]?.(mainFrame);

    expect(state.roleRefs).toBeUndefined();
    expect(state.roleRefsMode).toBeUndefined();
    expect(state.roleRefsFrameSelector).toBeUndefined();
    expect(() => refLocator(page, "e1")).toThrow(/Unknown ref/);
  });

  it("clears role refs on main-frame navigation (aria mode)", () => {
    const { page, handlers, mainFrame } = fakePage();
    const state = ensurePageState(page);

    storeRoleRefsForTarget({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "t1",
      refs: { e1: { role: "button", name: "Save" } },
      mode: "aria",
    });
    expect(state.roleRefs).toBeDefined();
    expect(state.roleRefsMode).toBe("aria");

    handlers.get("framenavigated")?.[0]?.(mainFrame);

    expect(state.roleRefs).toBeUndefined();
    expect(state.roleRefsMode).toBeUndefined();
    expect(() => refLocator(page, "e1")).toThrow(/Unknown ref/);
  });

  it("clears roleRefsFrameSelector on main-frame navigation", () => {
    const { page, handlers, mainFrame } = fakePage();
    const state = ensurePageState(page);

    storeRoleRefsForTarget({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "t1",
      refs: { e1: { role: "button", name: "OK" } },
      frameSelector: "iframe#content",
      mode: "role",
    });
    expect(state.roleRefsFrameSelector).toBe("iframe#content");

    handlers.get("framenavigated")?.[0]?.(mainFrame);

    expect(state.roleRefsFrameSelector).toBeUndefined();
  });

  it("preserves role refs on subframe navigation", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);

    storeRoleRefsForTarget({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "t1",
      refs: { e1: { role: "button", name: "MainBtn" } },
      mode: "role",
    });
    expect(Object.keys(state.roleRefs!)).toHaveLength(1);

    const subframe = { url: () => "https://ads.example.com/widget" };
    handlers.get("framenavigated")?.[0]?.(subframe);

    expect(state.roleRefs).toBeDefined();
    expect(Object.keys(state.roleRefs!)).toHaveLength(1);
  });

  it("allows new snapshot to store fresh refs after navigation clear", () => {
    const { page, handlers, mainFrame } = fakePage();
    const state = ensurePageState(page);

    storeRoleRefsForTarget({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "t1",
      refs: { e1: { role: "button", name: "PageA-Btn" } },
      mode: "role",
    });

    handlers.get("framenavigated")?.[0]?.(mainFrame);
    expect(state.roleRefs).toBeUndefined();

    storeRoleRefsForTarget({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "t1",
      refs: { e1: { role: "heading", name: "PageB Title" } },
      mode: "aria",
    });
    expect(state.roleRefs).toBeDefined();
    expect(state.roleRefs!.e1.role).toBe("heading");
    expect(state.roleRefsMode).toBe("aria");
  });

  it("registers framenavigated listener on ensurePageState", () => {
    const handlers2 = new Map<string, Array<(...args: unknown[]) => void>>();
    const page2 = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const list = handlers2.get(event) ?? [];
        list.push(cb);
        handlers2.set(event, list);
      },
      off: () => {},
      getByRole: () => ({ nth: () => ({ ok: true }) }),
      frameLocator: () => ({
        getByRole: () => ({ nth: () => ({ ok: true }) }),
        locator: () => ({ nth: () => ({ ok: true }) }),
      }),
      locator: () => ({ nth: () => ({ ok: true }) }),
      mainFrame: () => ({ url: () => "https://test.example.com" }),
    } as unknown as Page;

    ensurePageState(page2);
    expect(handlers2.has("framenavigated")).toBe(true);
    expect(handlers2.get("framenavigated")?.length).toBe(1);
  });
});
