import { describe, expect, it } from "vitest";
import { smokeShade } from "./assets";

describe("연기 색", () => {
  it("농도가 짙을수록 어둡고, 옅어도 흰 연무가 아니라 짙은 회색이다", () => {
    for (const seed of [0, 0.5, 1]) {
      const shades = [0.05, 0.2, 0.4, 0.6, 0.9].map((smoke) => smokeShade(smoke, seed));
      for (let index = 1; index < shades.length; index += 1) expect(shades[index]).toBeLessThanOrEqual(shades[index - 1]);
      // 가장 옅을 때도 밝기 100/255을 넘지 않는다. 통로를 막는 농도(0.5 이상)에서는 검정에 가깝다.
      expect(shades[0]).toBeLessThanOrEqual(100);
      expect(smokeShade(0.6, seed)).toBeLessThanOrEqual(40);
    }
    // 같은 농도에서도 입자마다 달라 한 가지 색의 면이 되지 않는다.
    expect(smokeShade(0.3, 0)).not.toBe(smokeShade(0.3, 1));
  });
});
