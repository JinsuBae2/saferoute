import { describe, expect, it } from "vitest";

import { drawIcon, ICON_PIXELS, signIcon } from "./icons";

describe("설비 아이콘 선택", () => {
  it("출구 위치 표지와 가변 방향 안내를 다른 아이콘으로 고른다", () => {
    expect(signIcon(true, true)).toBe("EXIT_ON");
    expect(signIcon(false, true)).toBe("DIRECTION_ON");
  });

  it("안내하지 않는 표지는 꺼진(회색) 아이콘이다", () => {
    expect(signIcon(true, false)).toBe("EXIT_OFF");
    expect(signIcon(false, false)).toBe("DIRECTION_OFF");
  });

  it("유도등은 같은 크기라 켜지고 꺼져도 화면에서 흔들리지 않는다", () => {
    expect(ICON_PIXELS.EXIT_ON).toEqual(ICON_PIXELS.EXIT_OFF);
    expect(ICON_PIXELS.DIRECTION_ON).toEqual(ICON_PIXELS.DIRECTION_OFF);
  });

  it("고른 카메라는 더 크게 보인다", () => {
    expect(ICON_PIXELS.CAMERA_PICKED.height).toBeGreaterThan(ICON_PIXELS.CAMERA.height);
  });

  it("문서가 없는 환경에서는 그림 없이 넘어간다", () => {
    expect(drawIcon("CAMERA")).toBeNull();
  });
});
