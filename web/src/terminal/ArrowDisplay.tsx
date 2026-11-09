/**
 * 서버가 정한 display 값을 그림으로만 바꾼다. 방향을 다시 계산하지 않는다.
 * 계단의 오르내림은 평면상의 좌우와 구분해서 그린다(명세 2.2절).
 */
import type { FaceResult } from "@contracts";

export type DisplayValue = NonNullable<FaceResult["display"]>;

export const DISPLAY_LABEL: Record<DisplayValue, string> = {
  LEFT: "왼쪽",
  RIGHT: "오른쪽",
  FORWARD: "앞으로",
  BACK: "뒤로",
  STAIRS_UP: "위층 계단",
  STAIRS_DOWN: "아래층 계단",
  EXIT: "출구",
};

const PLANE_ROTATION: Partial<Record<DisplayValue, number>> = {
  FORWARD: 0,
  RIGHT: 90,
  BACK: 180,
  LEFT: 270,
};

const ARROW_PATH = "M50 6 L88 46 H66 V94 H34 V46 H12 Z";

function Svg({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={label} className="glyph">
      {children}
    </svg>
  );
}

export function ArrowGlyph({ display }: { display: DisplayValue }) {
  const label = DISPLAY_LABEL[display];
  const rotation = PLANE_ROTATION[display];

  if (rotation !== undefined) {
    return (
      <Svg label={label}>
        <path d={ARROW_PATH} transform={`rotate(${rotation} 50 50)`} />
      </Svg>
    );
  }

  if (display === "STAIRS_UP" || display === "STAIRS_DOWN") {
    const up = display === "STAIRS_UP";
    const steps = up
      ? "M8 88 H30 V70 H50 V52 H70 V34 H92"
      : "M8 34 H30 V52 H50 V70 H70 V88 H92";
    const arrow = up ? "M62 26 L76 4 L90 26 Z" : "M62 74 L76 96 L90 74 Z";
    return (
      <Svg label={label}>
        <path d={steps} fill="none" strokeWidth={9} strokeLinejoin="round" strokeLinecap="round" />
        <path d={arrow} />
      </Svg>
    );
  }

  // EXIT: 유도등이 활성 출구 지점에 있을 때만 사용한다.
  return (
    <Svg label={label}>
      <path d="M6 42 H44 V58 H6 Z" />
      <path d="M40 28 L68 50 L40 72 Z" />
      <path d="M74 10 H94 V90 H74" fill="none" strokeWidth={9} strokeLinejoin="round" />
    </Svg>
  );
}

/** 안내할 방향이 없을 때. 화살표를 지우고 금지 표시를 쓴다. */
export function UnavailableGlyph({ label }: { label: string }) {
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={label} className="glyph glyph--muted">
      <circle cx={50} cy={50} r={38} fill="none" strokeWidth={9} />
      <path d="M23 23 L77 77" strokeWidth={9} strokeLinecap="round" />
    </svg>
  );
}
