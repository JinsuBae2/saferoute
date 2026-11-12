import { expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { readLatestPreview } from "./useCameraPreview";

const replaced = new ApiError(404, "PREVIEW_FRAME_UNAVAILABLE", null, "replaced");

it("reads a new metadata/image pair once when the old frame has been replaced", async () => {
  const read = vi.fn().mockRejectedValueOnce(replaced).mockResolvedValueOnce(undefined);
  await readLatestPreview(read);
  expect(read).toHaveBeenCalledTimes(2);
});

it("bounds replacement retries and propagates unrelated errors", async () => {
  const read = vi.fn().mockRejectedValue(replaced);
  await expect(readLatestPreview(read)).rejects.toBe(replaced);
  expect(read).toHaveBeenCalledTimes(2);
  const unavailable = new ApiError(503, "CONTROLLER_UNAVAILABLE", null, "offline");
  const offline = vi.fn().mockRejectedValue(unavailable);
  await expect(readLatestPreview(offline)).rejects.toBe(unavailable);
  expect(offline).toHaveBeenCalledTimes(1);
});
